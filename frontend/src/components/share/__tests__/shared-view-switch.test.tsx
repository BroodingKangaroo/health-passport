import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'

import { SharedRecordView } from '@/components/share/SharedRecordView'
import { sharedViewMessages } from '@/i18n/shared-messages'
import type { SharedRecord } from '@/lib/share'

/**
 * ST2: the recipient chooses between the summary and the full record.
 *
 * The contract worth pinning: the default is the summary, the choice is a URL
 * (`?view=`), the control is a plain link pair that works without JavaScript,
 * the full record carries no write affordance, and BOTH views render from the
 * narrow message subset the shared surface ships — the full view reuses the
 * owner's components, so a missing namespace would show a stranger a raw key.
 */

const fetchMock = vi.fn()

const record: SharedRecord = {
  meta: {
    created_at: '2026-09-15T10:00:00+00:00',
    expires_at: '2026-09-22T10:00:00+00:00',
    last_updated: '2026-09-12T08:00:00+00:00',
    scope: { kind: 'all' },
    default_locale: null,
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

const flowsheet = {
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
  // Non-empty on purpose: the sparkline only renders when a row has numeric
  // readings, so an empty array would make "no chart" pass for the wrong
  // reason.
  biomarkers: [
    {
      id: 'hb',
      entry_id: 'blood-jan',
      definition: { id: 'hb', names: { en: 'Hemoglobin' }, synonyms: [], unit: 'g/dL' },
      value: 10.2,
      date: '2026-01-12T00:00:00+00:00',
      status: 'low',
      history: [],
    },
  ],
}

/**
 * next-intl reports a missing key through `console.error` and renders the raw
 * key path. On the public surface that means a stranger sees
 * `sharedView.full.heading` where a heading belongs — which is exactly what a
 * production run of this page did before this guard existed. Captured here
 * rather than asserted per view so every case below is covered.
 */
let consoleErrors: string[] = []

beforeEach(() => {
  consoleErrors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '))
  })
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => flowsheet })
  vi.stubGlobal(
    'fetch',
    fetchMock,
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function expectNoMissingMessages() {
  expect(consoleErrors.filter((line) => line.includes('MISSING_MESSAGE'))).toEqual([])
}

/** Renders with ONLY the shipped recipient subset, as the real page does. */
function renderView(initialView: 'summary' | 'full' = 'summary') {
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

function toggle() {
  return screen.getByTestId('shared-view-toggle')
}

describe('SharedRecordView view switch', () => {
  it('opens on the summary by default', () => {
    renderView()
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument()
    // The full record's own chrome is not rendered.
    expect(screen.queryByRole('heading', { name: 'History' })).not.toBeInTheDocument()
    expectNoMissingMessages()
  })

  it('renders the full record when the URL asked for it', () => {
    renderView('full')
    // The reused HistoryList's own heading — proof the `timeline.historyList`
    // namespace is in the shipped subset.
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument()
    // The timeline's inline detail for the only (blood test) entry.
    expect(screen.getByText('Hemoglobin')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument()
    expectNoMissingMessages()
  })

  it('offers the toggle as plain links that work without JavaScript', () => {
    renderView()
    const group = toggle()
    const summary = within(group).getByRole('link', { name: 'Summary' })
    const full = within(group).getByRole('link', { name: 'Full record' })
    expect(summary).toHaveAttribute('href', '/s/hp_test?view=summary')
    expect(full).toHaveAttribute('href', '/s/hp_test?view=full')
    // Plain anchors, not client-side navigation: the same URL works with
    // JavaScript off and is what a bookmark or a forwarded link contains.
    expect(summary.tagName).toBe('A')
    expect(full.tagName).toBe('A')
    expect(summary).toHaveAttribute('aria-current', 'page')
    expect(full).not.toHaveAttribute('aria-current')
  })

  it('switches in place and keeps the URL in step, without a navigation', () => {
    const pushState = vi.spyOn(window.history, 'pushState')
    renderView()

    fireEvent.click(within(toggle()).getByRole('link', { name: 'Full record' }))

    expect(pushState).toHaveBeenCalledTimes(1)
    expect(String(pushState.mock.calls[0][2])).toContain('view=full')
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument()
    expect(within(toggle()).getByRole('link', { name: 'Full record' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('follows back/forward rather than the address bar alone', () => {
    renderView('full')
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument()

    window.history.replaceState(null, '', '/s/hp_test?view=summary')
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument()
  })

  /**
   * The payload is ~1.3 MB on the wire and the table belongs to BOTH views, so
   * a switch that re-requested it would be the most expensive thing this page
   * does. The shell owns the fetch (`useSharedFlowsheet` in `SharedRecordView`)
   * precisely so the toggle is free; this is the assertion that keeps it that
   * way.
   */
  it('never re-requests the flowsheet when the view is switched', async () => {
    renderView()
    // Let the one legitimate request land.
    expect(await screen.findByText('Longitudinal Lab Flowsheet')).toBeInTheDocument()
    const afterLoad = fetchMock.mock.calls.length
    expect(afterLoad).toBe(1)

    fireEvent.click(within(toggle()).getByRole('link', { name: 'Full record' }))
    fireEvent.click(within(toggle()).getByRole('link', { name: 'Summary' }))
    fireEvent.click(within(toggle()).getByRole('link', { name: 'Full record' }))
    await screen.findByRole('heading', { name: 'History' })

    expect(fetchMock.mock.calls.length).toBe(afterLoad)
  })

  it('offers no write affordance in the full record', () => {
    renderView('full')
    // The detail views are the owner's; for a recipient the document and
    // settings tabs are not rendered at all.
    expect(screen.queryByRole('tab', { name: /Settings/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Documents/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Danger Zone')).not.toBeInTheDocument()
    expect(screen.queryByText('Entry Details')).not.toBeInTheDocument()
    expect(screen.queryByText('Copy entry ID')).not.toBeInTheDocument()
  })

  /**
   * The desktop rail takes 280px of the viewport, and between ~1024px and
   * ~1400px the results table's owner-sized 768px floor did not fit the
   * recipient's pane — at 1280 it overflowed far enough to push the STATUS
   * column off the right edge. The recipient gets a narrower floor; the owner
   * keeps theirs.
   */
  it('uses the narrower results-table floor for a recipient', () => {
    renderView('full')
    const table = document.querySelector<HTMLElement>('div[style*="min-width"]')
    expect(table?.style.minWidth).toBe('620px')
  })

  it('shows the results matrix without the sparkline column', async () => {
    renderView()
    // The matrix is fetched after mount; wait for its own header to prove it
    // rendered before asserting what is missing from it.
    expect(await screen.findByText('Longitudinal Lab Flowsheet')).toBeInTheDocument()
    expect(screen.getAllByText('Hemoglobin').length).toBeGreaterThan(0)
    // ...and the trend column, the only recharts consumer on this page, is
    // gone: `SharedFlowsheet` passes `showTrend={false}`.
    expect(screen.queryByText('TREND')).not.toBeInTheDocument()
  })

  it('renders no chart when a reading row is expanded', () => {
    renderView('full')
    // Expanding a row is how the owner reaches the trend chart. Assert the
    // panel really opened first, or "no chart" would pass on a row that never
    // expanded.
    fireEvent.click(screen.getByRole('button', { name: /Hemoglobin/ }))
    expect(screen.getByText('LATEST')).toBeInTheDocument()
    expect(screen.getByText('READING HISTORY')).toBeInTheDocument()
    // ...and a recipient gets the numbers and the reading list only: the
    // chart, and therefore recharts, never loads on their page.
    expect(screen.queryByText('Hemoglobin Dynamics')).not.toBeInTheDocument()
    expect(
      document.querySelector('[class*="recharts"]'),
    ).toBeNull()
  })

  it('keeps the disclosure and the call to action in both views', () => {
    renderView()
    expect(screen.getByRole('link', { name: 'Make your own HealthPassport' })).toBeInTheDocument()
    expect(
      screen.getByText(/It is not a medical opinion or a diagnosis/),
    ).toBeInTheDocument()
  })
})
