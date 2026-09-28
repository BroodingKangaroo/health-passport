import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'

import { SharedPrintEditor } from '@/components/share/SharedPrintEditor'
import { measureColumnWidths } from '@/components/share/print-fit'
import { sharedViewMessages } from '@/i18n/shared-messages'
import { PrintConfigProvider } from '@/providers/print-config-provider'
import type { SharedFlowsheet, SharedRecord } from '@/lib/share'

/**
 * Item 1 of the whole-change review, at the wiring level.
 *
 * The arithmetic lives in `print-fit.ts` and is unit-tested there; what this
 * file pins is that the recipient's editor USES it: the default selection is
 * trimmed to what the page can hold (never the owner's behaviour, which is
 * out of scope), and a selection that still overflows is announced instead of
 * being clipped silently.
 *
 * jsdom has no layout, so every `getBoundingClientRect()` is zero and the real
 * measurement is useless here — the widths it would return are supplied
 * instead, at the same scale the live record measured.
 */
vi.mock('@/components/share/print-fit', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/share/print-fit')>()
  return { ...actual, measureColumnWidths: vi.fn(() => []) }
})

const dates = [
  'Jan 12',
  'Feb 20',
  'Mar 20',
  'Apr 24',
  'May 08',
  'Jun 25',
  'Jul 30',
  'Sep 17',
]

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
  events: [],
  biomarkers: [],
  visits: {},
  instrumental: {},
}

const flowsheet: SharedFlowsheet = {
  dates: dates.map((label) => ({ label, sub: null, source_language: null })),
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
          cells: dates.map((_, i) => ({
            value: i === dates.length - 1 ? '10.2' : '\u2014',
            status: i === dates.length - 1 ? 'low' : '',
          })),
        },
      ],
    },
  ],
  biomarkers: [],
}

function renderEditor() {
  return render(
    <NextIntlClientProvider locale="en" messages={sharedViewMessages('en')}>
      <PrintConfigProvider persist={false}>
        <SharedPrintEditor
          record={record}
          flowsheet={flowsheet}
          namesByLang={{}}
          onBack={() => {}}
        />
      </PrintConfigProvider>
    </NextIntlClientProvider>,
  )
}

function renderedColumns(): string[] {
  const headers = [...document.querySelectorAll('thead th')]
  return headers.map((th) => th.textContent?.trim() ?? '')
}

const measure = vi.mocked(measureColumnWidths)

beforeEach(() => {
  measure.mockReset()
  measure.mockReturnValue([])
})

/**
 * jsdom lays nothing out, so the widths are derived from the table the editor
 * ACTUALLY rendered — the real thing behaves the same way (fewer columns, less
 * width), and a mock with fixed numbers could not tell a trimmed document from
 * an untrimmed one.
 */
function mockWidths(nameWidth: number, columnWidth: number) {
  measure.mockImplementation((table: HTMLTableElement) =>
    [...table.querySelectorAll('thead th')].map((_, i) =>
      i === 0 ? nameWidth : columnWidth,
    ),
  )
}

describe('the recipient print editor and the page width', () => {
  it('opens on the newest columns that fit the page, not every column', async () => {
    // A 156px name column and eight 100px date columns: 956px against a 780px
    // page, so the oldest ones must go — six date columns plus the name is
    // 756px, and a seventh would cross the page.
    mockWidths(156, 100)
    renderEditor()

    await waitFor(() => {
      expect(renderedColumns()).toHaveLength(7)
    })
    const shown = renderedColumns().slice(1)
    expect(shown).toEqual([
      'Mar 20',
      'Apr 24',
      'May 08',
      'Jun 25',
      'Jul 30',
      'Sep 17',
    ])
    // The newest reading is still on the sheet.
    expect(screen.getAllByText(/10\.2/).length).toBeGreaterThan(0)
    // And the selection fits, so there is nothing to warn about.
    expect(screen.queryByTestId('print-editor-banner')).toBeNull()
  })

  it('warns instead of clipping when even the trimmed document is too wide', async () => {
    // A pathological record: the name column alone nearly fills the page.
    mockWidths(700, 200)
    renderEditor()

    await waitFor(() => {
      expect(screen.getByTestId('print-editor-banner')).toBeInTheDocument()
    })
    expect(
      screen.getByText(/More date columns are selected than fit on one page/),
    ).toBeInTheDocument()
    // At least one column survives — the warning accompanies a document, it
    // does not replace it.
    expect(renderedColumns()).toHaveLength(2)
  })
})
