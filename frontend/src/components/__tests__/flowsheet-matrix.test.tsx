import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { FlowsheetMatrix } from '../health-passport/flowsheet-matrix'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type {
  BiomarkerResult,
  DateHeader,
  MatrixCategory,
  MatrixRow,
} from '@/lib/types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const renderI18n = ((ui: React.ReactElement, options?: Parameters<typeof render>[1]) =>
  render(<TestI18nProvider>{ui}</TestI18nProvider>, options)) as typeof render

function makeDates(n: number): DateHeader[] {
  const labels = [
    'Mar 09, 2008', 'Mar 20, 2023', 'Mar 27, 2023', 'Apr 02, 2023',
    'Apr 16, 2023', 'Apr 24, 2023', 'May 08, 2023', 'May 26, 2023',
    'Jun 23, 2023', 'Jul 01, 2023',
  ]
  return Array.from({ length: n }, (_, i) => ({
    label: labels[i % labels.length],
    sub: i === 2 ? '17:00' : null,
    source_language: null,
  }))
}

function makeRow(id: string, name: string, values: (string | null)[]): MatrixRow {
  return {
    id,
    name,
    original: `${name} (ru)`,
    original_lang: null,
    unit: 'g/L',
    reference: { kind: 'interval', low: 1, high: 10 },
    cells: values.map((v) =>
      v === null
        ? { value: '—', status: 'normal' as const }
        : { value: v, status: 'normal' as const },
    ),
  }
}

function makeMatrix(rows: MatrixRow[]): MatrixCategory[] {
  return [{ category: 'Complete Blood Count', rows }]
}

function makeBiomarker(id: string): BiomarkerResult {
  return {
    id,
    entry_id: 'evt-1',
    definition: {
      id,
      names: { en: 'Hemoglobin', ru: 'Гемоглобин' },
      synonyms: [],
      category: 'Complete Blood Count',
      unit: 'g/L',
      reference: null,
      scope: 'global',
      reference_source: 'global',
    },
    value: 150,
    date: 'Mar 20, 2023',
    status: 'normal',
    history: [],
  }
}

describe('FlowsheetMatrix frozen columns', () => {
  it('pins the name column to a FIXED width (sticky-offset pairing with the trend column)', () => {
    // The trend column's sticky `left` is a static CSS value that must equal
    // the name column's resolved width; a minmax name would open a gap when
    // the grid is narrower than the name's max. Pin the grid template.
    const dates = makeDates(8)
    const { container } = renderI18n(
      <FlowsheetMatrix
        dates={dates}
        matrix={makeMatrix([makeRow('hgb', 'Hemoglobin', ['150', null, '151'])])}
        biomarkers={[makeBiomarker('hgb')]}
      />,
    )

    const header = container.querySelector('.grid[style*="grid-template-columns"]')!
    const template = (header as HTMLElement).style.gridTemplateColumns
    expect(template.startsWith('220px 80px')).toBe(true)
    expect(template).toContain('minmax(84px, 1fr)')
  })

  it('renders the frozen name/trend cells with opaque backgrounds above data rows', () => {
    const dates = makeDates(8)
    const { container } = renderI18n(
      <FlowsheetMatrix
        dates={dates}
        matrix={makeMatrix([makeRow('hgb', 'Hemoglobin', ['150'])])}
        biomarkers={[makeBiomarker('hgb')]}
      />,
    )

    const stickyName = container.querySelector('div.sticky.left-0.z-10')
    expect(stickyName).not.toBeNull()
    expect(stickyName?.className).toContain('bg-card')
    expect(stickyName?.className).toContain('group-hover:bg-muted/50')
    // Header context cells sit above the data sticky cells (z-20 > z-10).
    expect(container.querySelector('span.sticky.z-20')).not.toBeNull()
  })
})

describe('FlowsheetMatrix cells', () => {
  const dates = makeDates(4)

  it('renders empty cells as a faint dash with a tooltip, distinct from real values', () => {
    renderI18n(
      <FlowsheetMatrix
        dates={dates}
        matrix={makeMatrix([makeRow('hgb', 'Hemoglobin', [null, '150'])])}
        biomarkers={[makeBiomarker('hgb')]}
      />,
    )

    const empty = screen.getByTitle('Not measured in this panel')
    expect(empty.textContent).toBe('—')
    // The real value keeps its number (qualitative words are NOT collapsed).
    expect(screen.getByText('150')).toBeInTheDocument()
  })

  it('keeps qualitative results spelled out (never collapsed into the dash)', () => {
    renderI18n(
      <FlowsheetMatrix
        dates={dates}
        matrix={makeMatrix([makeRow('rot', 'Rotavirus', ['Absent'])])}
        biomarkers={[]}
      />,
    )

    expect(screen.getByText('Absent')).toBeInTheDocument()
  })

  it('renders unknown-status values neutrally (no bold/red flag)', () => {
    const row: MatrixRow = {
      ...makeRow('unk', 'Unclassifiable', ['7.7']),
      cells: [{ value: '7.7', status: '' }],
    }
    renderI18n(
      <FlowsheetMatrix
        dates={dates}
        matrix={makeMatrix([row])}
        biomarkers={[]}
      />,
    )

    const cell = screen.getByText('7.7')
    expect(cell.className).not.toContain('font-bold')
    expect(cell.className).not.toContain('text-status-high')
    expect(cell.className).toContain('text-foreground')
  })

  it('shows the legend line and compact two-line date headers', () => {
    renderI18n(
      <FlowsheetMatrix
        dates={makeDates(3)}
        matrix={makeMatrix([makeRow('hgb', 'Hemoglobin', ['150', '151', '149'])])}
        biomarkers={[makeBiomarker('hgb')]}
      />,
    )

    expect(screen.getByText('not measured')).toBeInTheDocument()
    // "Mar 27, 2023 17:00" renders as day + time sub-line; year columns get
    // the abbreviated year when there is no time.
    expect(screen.getByText('Mar 27')).toBeInTheDocument()
    expect(screen.getByText('17:00')).toBeInTheDocument()
    expect(screen.getByText('’23')).toBeInTheDocument()
  })
})

describe('FlowsheetMatrix date-range presets', () => {
  const dates = makeDates(8)

  it('offers presets only when there are enough columns to matter', () => {
    const { unmount } = renderI18n(
      <FlowsheetMatrix
        dates={makeDates(4)}
        matrix={makeMatrix([makeRow('hgb', 'Hemoglobin', ['150', '151', '149', '150'])])}
        biomarkers={[makeBiomarker('hgb')]}
      />,
    )
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull()
    unmount()

    renderI18n(
      <FlowsheetMatrix
        dates={dates}
        matrix={makeMatrix([
          makeRow('hgb', 'Hemoglobin', ['150', '151', '149', '150', '151', '149', '150', '151']),
        ])}
        biomarkers={[makeBiomarker('hgb')]}
      />,
    )
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Last 6' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Last 12' })).toBeInTheDocument()
  })

  it('narrows the matrix to the last N panels and reports the count', () => {
    renderI18n(
      <FlowsheetMatrix
        dates={dates}
        matrix={makeMatrix([
          makeRow('hgb', 'Hemoglobin', ['150', '151', '149', '150', '151', '149', '150', '151']),
        ])}
        biomarkers={[makeBiomarker('hgb')]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Last 6' }))
    // The two earliest columns drop out; the count line reflects the window.
    expect(screen.getByText('6 of 8 panels')).toBeInTheDocument()
    expect(screen.queryByText('Mar 09')).toBeNull()
    expect(screen.getAllByText('151').length).toBeGreaterThan(0)
    // Restoring "All" brings every column back.
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('Mar 09')).toBeInTheDocument()
  })
})

describe('FlowsheetMatrix narrow layout (Stage 3, S11/S12)', () => {
  /** jsdom has no matchMedia; stubbing it puts the component on the narrow
   *  branch that real phones take. */
  function stubNarrowViewport(matches: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders card-per-biomarker below the breakpoint, hiding the wide table', () => {
    stubNarrowViewport(true)
    const { container } = renderI18n(
      <FlowsheetMatrix
        dates={makeDates(4)}
        matrix={makeMatrix([
          makeRow('hgb', 'Hemoglobin', ['150', '151', '149', '152']),
          makeRow('tsh', 'TSH', ['2.5', '2.8', '3.0', '3.1']),
        ])}
        biomarkers={[makeBiomarker('hgb')]}
      />,
    )

    // The wide grid is still in the DOM (print needs it) but hidden on
    // screen; the cards replace it for actual reading.
    const grid = container.querySelector('.overflow-x-auto') as HTMLElement
    expect(grid.className).toContain('hidden')
    expect(grid.className).toContain('print:block')

    const cards = screen.getByTestId('flowsheet-cards')
    expect(cards.className).toContain('print:hidden')
    // Every biomarker gets a card with its latest value and the full history
    // as chips — nothing is lost by dropping the columns.
    expect(within(cards).getByText('Hemoglobin')).toBeInTheDocument()
    expect(within(cards).getByText('TSH')).toBeInTheDocument()
    expect(screen.getAllByText(/152/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/150/).length).toBeGreaterThan(0)
    // A shared recipient gets no navigation affordance: rows stay text.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps the table-only layout on wide viewports (no duplicated cards)', () => {
    stubNarrowViewport(false)
    const { container } = renderI18n(
      <FlowsheetMatrix
        dates={makeDates(3)}
        matrix={makeMatrix([makeRow('hgb', 'Hemoglobin', ['150', '151', '149'])])}
        biomarkers={[makeBiomarker('hgb')]}
      />,
    )

    expect(screen.queryByTestId('flowsheet-cards')).toBeNull()
    const grid = container.querySelector('.overflow-x-auto') as HTMLElement
    expect(grid.className).not.toContain('hidden')
  })

  it('cards navigate to the biomarker details when the caller provides the route', () => {
    stubNarrowViewport(true)
    const onOpenBiomarker = vi.fn()
    renderI18n(
      <FlowsheetMatrix
        dates={makeDates(3)}
        matrix={makeMatrix([makeRow('hgb', 'Hemoglobin', ['150', '151', '149'])])}
        biomarkers={[makeBiomarker('hgb')]}
        onOpenBiomarker={onOpenBiomarker}
      />,
    )

    const cards = screen.getByTestId('flowsheet-cards')
    const card = within(cards).getByRole('button', { name: /Hemoglobin/ })
    fireEvent.click(card)
    expect(onOpenBiomarker).toHaveBeenCalledWith('hgb')
  })
})
