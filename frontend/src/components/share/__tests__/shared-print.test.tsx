import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'

import { SharedRecordView } from '@/components/share/SharedRecordView'
import { SharedPrintFlow } from '@/components/share/SharedPrintFlow'
import { createSharePrintSource } from '@/components/share/share-print-source'
import { sharedViewMessages } from '@/i18n/shared-messages'
import {
  SharedTranslationLimitError,
  type SharedFlowsheet,
  type SharedPrintStage,
  type SharedRecord,
} from '@/lib/share'

/**
 * ST4: the recipient can print the passport, and the AI translation that a
 * printed document may need is bounded by the LINK.
 *
 * The three claims pinned here:
 *
 * 1. The print flow is reachable from both views and carries its state in the
 *    URL (the same contract as the view toggle).
 * 2. The budget is visible BEFORE it is spent, and the refusal is a message on
 *    the setup screen rather than a silent English-fallback document.
 * 3. The recipient's source posts only the language — the payload is derived
 *    server-side — and its "commit" writes nothing anywhere.
 */

const record: SharedRecord = {
  meta: {
    created_at: '2026-09-15T10:00:00+00:00',
    expires_at: '2026-09-22T10:00:00+00:00',
    last_updated: '2026-09-12T08:00:00+00:00',
    scope: { kind: 'all' },
    default_locale: null,
    translation_remaining: 3,
    translation_budget: 3,
  },
  header: { name: 'Test User', dob: '1990-01-01', gender: 'Other' },
  events: [
    {
      id: 'blood-jan',
      type: 'blood_test',
      date: '2026-01-12T00:00:00+00:00',
      title: 'New Year Baseline',
      subtitle: '',
      category: 'Labs',
      status: '',
      clinic: 'CityLab Diagnostics',
      attachments: [],
    },
  ],
  biomarkers: [
    {
      id: 'hb',
      entry_id: 'blood-jan',
      definition: {
        id: 'hb',
        names: { en: 'Hemoglobin', ru: 'Гемоглобин' },
        synonyms: [],
        unit: 'g/dL',
        category: 'Complete Blood Count',
        scope: 'global',
        reference: { kind: 'interval', low: 12, high: 16 },
        reference_source: 'global',
      },
      value: 10.2,
      date: '2026-01-12T00:00:00+00:00',
      status: 'low',
      history: [],
      reference: { kind: 'interval', low: 12, high: 16 },
    },
  ],
  visits: {},
  instrumental: {},
}

const flowsheet: SharedFlowsheet = {
  dates: [{ label: 'Jan 12', sub: null, source_language: null }],
  matrix: [
    {
      category: 'Complete Blood Count',
      rows: [
        {
          id: 'hb',
          name: 'Hemoglobin',
          original: 'Гемоглобин',
          original_lang: null,
          unit: 'g/dL',
          reference: { kind: 'interval', low: 12, high: 16 },
          cells: [{ value: '10.2', status: 'low' }],
        },
      ],
    },
  ],
  biomarkers: [],
}

const flowsheetState = {
  flowsheet,
  status: 'ready' as const,
  retry: () => {},
}

function renderFlow(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={sharedViewMessages('en')}>
      {ui}
    </NextIntlClientProvider>,
  )
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  window.history.replaceState(null, '', '/s/hp_test')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createSharePrintSource', () => {
  const translationBody = {
    translations: [{ id: 'hb', name: 'Hämoglobin', source: 'translated' }],
    categories: [
      { original: 'Complete Blood Count', translated: 'Blutbild', source: 'translated' },
    ],
    remaining: 2,
  }

  it('asks for the language only, and carries the token in a header', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => translationBody,
    })
    const source = createSharePrintSource({
      token: 'hp_test',
      locale: 'de',
      flowsheet: async () => flowsheet,
      onTranslations: () => {},
      enterEditor: () => {},
    })

    const result = await source.translate('de', [{ id: 'hb', name: 'Hemoglobin' }], {})

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/share/translate')
    // The body is the language and nothing else: the names come from the
    // link's own record, server-side, so a caller cannot widen the batch.
    expect(JSON.parse(init.body as string)).toEqual({ lang: 'de' })
    expect(init.headers).toMatchObject({
      'X-Share-Token': 'hp_test',
      'Accept-Language': 'de',
    })
    expect(result.names.get('hb')).toEqual({ name: 'Hämoglobin', source: 'translated' })
    expect(result.categories).toEqual({ 'Complete Blood Count': 'Blutbild' })
    expect(result.remaining).toBe(2)
  })

  it('surfaces a spent budget as its own error, not a generic failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    const source = createSharePrintSource({
      token: 'hp_test',
      locale: 'en',
      flowsheet: async () => flowsheet,
      onTranslations: () => {},
      enterEditor: () => {},
    })
    await expect(
      source.translate('de', [{ id: 'hb', name: 'Hemoglobin' }], {}),
    ).rejects.toBeInstanceOf(SharedTranslationLimitError)
  })

  it('applies accepted terms to the document and writes nothing', async () => {
    const onTranslations = vi.fn()
    const source = createSharePrintSource({
      token: 'hp_test',
      locale: 'en',
      flowsheet: async () => flowsheet,
      onTranslations,
      enterEditor: () => {},
    })
    const outcome = await source.commit?.(
      'de',
      [{ id: 'hb', name: 'Hämoglobin' }],
      { complete: false },
    )

    expect(outcome).toEqual({ saved: 0 })
    // The completeness flag rides through to the flow, which is what keeps a
    // half-translated document retryable.
    const [calledLang, calledItems, calledOpts] = onTranslations.mock.calls[0]
    expect(calledLang).toBe('de')
    expect(calledItems).toEqual([{ id: 'hb', name: 'Hämoglobin' }])
    expect(calledOpts).toEqual({ complete: false })
    // No commit request: a recipient has nowhere to persist, and the record's
    // own dictionary must never be written by a stranger.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('SharedPrintFlow budget', () => {
  it('shows the remaining runs before one is spent, and opens the editor normally', () => {
    const onStage = vi.fn()
    renderFlow(
      <SharedPrintFlow
        token="hp_test"
        record={record}
        locale="en"
        stage="setup"
        onStage={onStage}
        onClose={() => {}}
        flowsheetState={flowsheetState}
      />,
    )

    // Translate mode + a language make the budget relevant; the bar is
    // hidden for "keep original" and English, which run no model.
    fireEvent.click(screen.getAllByRole('radio')[1])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
    expect(screen.getByTestId('print-translation-budget').textContent).toContain(
      '3 AI translations left for this document',
    )
  })

  it('blocks on the spent budget with a message instead of an English document', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    const onStage = vi.fn()
    renderFlow(
      <SharedPrintFlow
        token="hp_test"
        record={record}
        locale="en"
        stage="setup"
        onStage={onStage}
        onClose={() => {}}
        flowsheetState={flowsheetState}
      />,
    )

    fireEvent.click(screen.getAllByRole('radio')[1])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate Document/ }))

    await waitFor(() =>
      expect(screen.getByTestId('print-translation-budget').textContent).toContain(
        'No AI translations left for this document',
      ),
    )
    // The reader stays on the setup screen — the editor would have shown an
    // untranslated document that looks like a translation bug.
    expect(onStage).not.toHaveBeenCalled()
  })

  /**
   * Found live in a production build: the owner's `PrintEditorView` selects
   * every column and every biomarker after its fetch, and the shared
   * container did not — so the recipient's document opened saying "Select at
   * least one date column" over an empty table. The initialisation is the
   * shared container's job now, and this is the guard.
   */
  it('opens the document with the full table already selected', () => {
    renderFlow(
      <SharedPrintFlow
        token="hp_test"
        record={record}
        locale="en"
        stage="editor"
        onStage={() => {}}
        onClose={() => {}}
        flowsheetState={flowsheetState}
      />,
    )
    expect(screen.queryByText('Select at least one date column.')).toBeNull()
    expect(screen.getAllByText('Hemoglobin').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Jan 12').length).toBeGreaterThan(0)
  })
})

/**
 * F3 (ST4 review): the budget is three Generate presses for three LANGUAGES,
 * not three presses.
 *
 * A recipient's run persists nothing, so the server cannot tell that a
 * language was already paid for — the client has to. The mirror case matters
 * just as much: a run that FELL BACK for some terms is not reusable, or a
 * reader would be stuck with a half-translated document and no retry.
 */
describe('regenerating the same language', () => {
  /** The flow as the real shell drives it: the stage is state, not a prop. */
  function Harness() {
    const [stage, setStage] = useState<SharedPrintStage>('setup')
    return (
      <SharedPrintFlow
        token="hp_test"
        record={record}
        locale="en"
        stage={stage}
        onStage={setStage}
        onClose={() => {}}
        flowsheetState={flowsheetState}
      />
    )
  }

  function translateCalls() {
    return fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/share/translate'),
    ).length
  }

  /** Generate German, accept the review dialog, and land in the editor. */
  async function generateGerman() {
    fireEvent.click(screen.getAllByRole('radio')[1])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
    const generate = () =>
      screen.getAllByRole('button', { name: /Generate Document/ }).at(-1)!
    fireEvent.click(generate())
    // The review dialog's confirm button shares the accessible name, and the
    // dialog's copy is the LAST match — same convention as the owner's tests.
    await waitFor(() => expect(screen.getByText('Verify Translations')).toBeTruthy())
    fireEvent.click(generate())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Back to Setup/ })).toBeTruthy(),
    )
  }

  it('spends nothing on a second Generate for a language already generated', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        translations: [{ id: 'hb', name: 'Hämoglobin', source: 'translated' }],
        categories: [
          { original: 'Complete Blood Count', translated: 'Blutbild', source: 'translated' },
        ],
        remaining: 2,
      }),
    })
    renderFlow(<Harness />)

    await generateGerman()
    expect(translateCalls()).toBe(1)

    // Back to the setup screen and generate the SAME language again.
    fireEvent.click(screen.getByRole('button', { name: /Back to Setup/ }))
    await waitFor(() => expect(screen.getByText('Prepare Document for Print/Export')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('radio')[1])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
    // The budget the reader sees is the one the RUN reported (2), not the
    // record payload's page-load value (3): the count lives in the flow, so
    // returning to the setup screen cannot overstate what is left.
    expect(screen.getByTestId('print-translation-budget').textContent).toContain(
      '2 AI translations left for this document',
    )
    fireEvent.click(screen.getAllByRole('button', { name: /Generate Document/ }).at(-1)!)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Back to Setup/ })).toBeTruthy(),
    )
    // Still one call: the second press reused the accepted terms.
    expect(translateCalls()).toBe(1)
  })

  it('still retries when the previous run fell back for some terms', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        // A fallback item: the document was NOT fully translated, so the
        // reader must be able to ask again.
        translations: [{ id: 'hb', name: 'Hemoglobin', source: 'fallback' }],
        categories: [],
        remaining: 2,
      }),
    })
    renderFlow(<Harness />)

    await generateGerman()
    expect(translateCalls()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /Back to Setup/ }))
    await waitFor(() => expect(screen.getByText('Prepare Document for Print/Export')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('radio')[1])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'de' } })
    fireEvent.click(screen.getAllByRole('button', { name: /Generate Document/ }).at(-1)!)

    await waitFor(() => expect(translateCalls()).toBe(2))
  })
})

describe('the print entry point', () => {
  function renderView(initialView: 'summary' | 'full') {
    return render(
      <NextIntlClientProvider locale="en" messages={sharedViewMessages('en')}>
        <SharedRecordView
          token="hp_test"
          record={record}
          locale="en"
          initialView={initialView}
        />
      </NextIntlClientProvider>,
    )
  }

  it('is reachable from BOTH views', () => {
    const summary = renderView('summary')
    expect(screen.getByTestId('shared-print-button')).toBeInTheDocument()
    summary.unmount()

    renderView('full')
    expect(screen.getByTestId('shared-print-button')).toBeInTheDocument()
  })

  it('opens the print setup through the URL, so Back returns to the record', () => {
    const pushState = vi.spyOn(window.history, 'pushState')
    renderView('summary')

    fireEvent.click(screen.getByTestId('shared-print-button'))

    expect(pushState).toHaveBeenCalled()
    expect(window.location.search).toBe('?print=setup')
  })
})
