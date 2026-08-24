import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ExpandedBiomarkerDetails } from '../health-passport/expanded-biomarker-details'
import type { BiomarkerDefinition, BiomarkerResult, Reading } from '@/lib/types'

vi.mock('@/components/shared/BiomarkerChart', () => ({
  BiomarkerChart: ({ data }: { data: Reading[] }) => (
    <div data-testid="chart" data-dates={data.map((d) => d.date).join('|')} />
  ),
}))

const definition: BiomarkerDefinition = {
  id: 'esr',
  names: { en: 'ESR', ru: 'СОЭ' },
  synonyms: [],
  unit: 'mm/h',
  reference: { kind: 'interval', low: null, high: 15 },
  category: '',
  scope: 'global',
  reference_source: 'global',
}

// Chronological series: Apr 10, Apr 24, May 16, May 26. The user selected the
// May 16 event (mid-series), so biomarkersAtDate promotes it to the top-level
// "current" slot and keeps the other three as history — the exact shape that
// used to render the x-axis as Apr 24 → May 26 → May 16.
const apr10: Reading = {
  entry_id: 'evt-1',
  date: '2026-04-10T09:00:00',
  value: 18,
  status: 'high',
  scale_function: 'factor:2',
  original_value: '36',
  original_unit: 'mm/2h',
}
const apr24: Reading = { entry_id: 'evt-2', date: '2026-04-24T17:01:00', value: 6, status: 'normal' }
const may26: Reading = { entry_id: 'evt-4', date: '2026-05-26T17:03:00', value: 8, status: 'normal' }

const biomarker: BiomarkerResult = {
  id: 'esr',
  entry_id: 'evt-3',
  definition,
  value: 14,
  date: '2026-05-16T16:57:00',
  status: 'normal',
  history: [apr10, apr24, may26],
}

describe('ExpandedBiomarkerDetails with a mid-series selected event', () => {
  it('feeds the chart a chronologically sorted series', () => {
    render(<ExpandedBiomarkerDetails biomarker={biomarker} />)
    expect(screen.getByTestId('chart').getAttribute('data-dates')).toBe(
      '2026-04-10T09:00:00|2026-04-24T17:01:00|2026-05-16T16:57:00|2026-05-26T17:03:00',
    )
  })

  it('renders reading-history chips newest → oldest', () => {
    render(<ExpandedBiomarkerDetails biomarker={biomarker} />)
    const chips = screen.getAllByRole('listitem')
    expect(chips.map((c) => c.textContent)).toEqual([
      expect.stringContaining('May 26, 2026'),
      expect.stringContaining('May 16, 2026'),
      expect.stringContaining('Apr 24, 2026'),
      expect.stringContaining('Apr 10, 2026'),
    ])
  })

  it('keeps ScaleNote metadata attached to the right reading after sorting', () => {
    render(<ExpandedBiomarkerDetails biomarker={biomarker} />)
    // Only the Apr 10 history reading carries scale metadata; getByTitle fails
    // if the note leaked onto any other chip (the old positional lookup bug).
    expect(
      screen.getByTitle('Original: 36 mm/2h • Converted via factor:2'),
    ).toBeInTheDocument()
  })
})
