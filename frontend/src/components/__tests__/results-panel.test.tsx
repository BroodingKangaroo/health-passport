import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ResultsPanel } from '../health-passport/results-panel'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { BiomarkerDefinition, BiomarkerResult, Reference } from '@/lib/types'

const renderI18n = ((ui: React.ReactElement, options?: Parameters<typeof render>[1]) =>
  render(<TestI18nProvider>{ui}</TestI18nProvider>, options)) as typeof render

function makeBiomarker(
  id: string,
  en: string,
  overrides: Partial<BiomarkerResult> = {},
  ru: string = `${en} (ru)`,
): BiomarkerResult {
  return {
    id,
    entry_id: 'evt-1',
    definition: {
      id,
      names: { en, ru },
      synonyms: [],
      category: 'Complete Blood Count',
      unit: 'g/L',
      reference: null,
      scope: 'global',
      reference_source: 'global',
    },
    value: 150,
    date: 'Jan 15, 2027',
    status: 'normal',
    ...overrides,
  }
}

function defWith(id: string, en: string, props: Partial<BiomarkerDefinition>, ru: string = `${en} (ru)`): BiomarkerDefinition {
  return { ...makeBiomarker(id, en, {}, ru).definition, ...props }
}

function intervalRef(low: number | null, high: number | null): Reference {
  return { kind: 'interval', low, high }
}

function qualitativeRef(expected: string): Reference {
  return { kind: 'qualitative', expected }
}

/** Asserts each named element appears in document order after the previous one. */
function expectRowOrder(names: string[]) {
  for (let i = 0; i + 1 < names.length; i += 1) {
    const a = screen.getByText(names[i])
    const b = screen.getByText(names[i + 1])
    expect(
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true)
  }
}

function headerButton(label: string): HTMLElement {
  return screen.getByRole('button', { name: label })
}

function ariaSortOf(label: string): string | null {
  const cell = headerButton(label).closest('div')
  expect(cell).not.toBeNull()
  return cell?.getAttribute('aria-sort') ?? null
}

const NAME_HEADER = 'Biomarker (EN)'
const ORIGINAL_HEADER = 'Original Name'
const VALUE_HEADER = 'Latest'
const UNIT_HEADER = 'Unit'
const REFERENCE_HEADER = 'Reference range'
const STATUS_HEADER = 'Status'

describe('ResultsPanel sorting', () => {
  it('renders rows in document order when no sort is active', () => {
    const biomarkers = [
      makeBiomarker('z', 'Zebra'),
      makeBiomarker('a', 'Apple'),
      makeBiomarker('m', 'Mango'),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    expectRowOrder(['Zebra', 'Apple', 'Mango'])
    expect(ariaSortOf(NAME_HEADER)).toBeNull()
  })

  it('cycles name sort asc -> desc -> default (3-state)', () => {
    const biomarkers = [
      makeBiomarker('z', 'Zebra'),
      makeBiomarker('a', 'Apple'),
      makeBiomarker('m', 'Mango'),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    const nameBtn = () => headerButton(NAME_HEADER)

    fireEvent.click(nameBtn())
    expect(ariaSortOf(NAME_HEADER)).toBe('ascending')
    expectRowOrder(['Apple', 'Mango', 'Zebra'])

    fireEvent.click(nameBtn())
    expect(ariaSortOf(NAME_HEADER)).toBe('descending')
    expectRowOrder(['Zebra', 'Mango', 'Apple'])

    fireEvent.click(nameBtn())
    expect(ariaSortOf(NAME_HEADER)).toBeNull()
    expectRowOrder(['Zebra', 'Apple', 'Mango'])
  })

  it('clears the previous column state when sorting by another column', () => {
    const biomarkers = [
      makeBiomarker('a', 'Apple', { status: 'low' }),
      makeBiomarker('b', 'Banana', { status: 'normal' }),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    fireEvent.click(headerButton(NAME_HEADER))
    expect(ariaSortOf(NAME_HEADER)).toBe('ascending')
    expect(ariaSortOf(STATUS_HEADER)).toBeNull()

    fireEvent.click(headerButton(STATUS_HEADER))
    expect(ariaSortOf(STATUS_HEADER)).toBe('ascending')
    expect(ariaSortOf(NAME_HEADER)).toBeNull()
  })

  it('sorts values numerically, text values after numbers, nulls last in both directions', () => {
    const biomarkers = [
      makeBiomarker('gamma', 'Gamma', { value: 'Positive' }),
      makeBiomarker('delta', 'Delta', { value: null }),
      makeBiomarker('beta', 'Beta', { value: 5 }),
      makeBiomarker('alpha', 'Alpha', { value: 12.5 }),
      makeBiomarker('eps', 'Epsilon', { value: 'Negative' }),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    const valueBtn = () => headerButton(VALUE_HEADER)

    fireEvent.click(valueBtn())
    expectRowOrder(['Beta', 'Alpha', 'Epsilon', 'Gamma', 'Delta'])

    fireEvent.click(valueBtn())
    // Descending flips within groups, but nulls stay last.
    expectRowOrder(['Alpha', 'Beta', 'Gamma', 'Epsilon', 'Delta'])
  })

  it('sorts status by clinical severity rank', () => {
    const biomarkers = [
      makeBiomarker('c', 'Charlie', { status: 'high' }),
      makeBiomarker('b', 'Bravo', { status: 'normal' }),
      makeBiomarker('d', 'Delta', { status: 'abnormal' }),
      makeBiomarker('a', 'Alpha', { status: 'low' }),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    fireEvent.click(headerButton(STATUS_HEADER))
    expectRowOrder(['Bravo', 'Alpha', 'Charlie', 'Delta'])

    fireEvent.click(headerButton(STATUS_HEADER))
    expectRowOrder(['Delta', 'Charlie', 'Alpha', 'Bravo'])
  })

  it('sorts references by interval bounds first, then qualitative text, missing last', () => {
    const biomarkers = [
      makeBiomarker('rh', 'RefHigh', { reference: intervalRef(4, 11) }),
      makeBiomarker('rq', 'RefQual', { reference: qualitativeRef('Negative') }),
      makeBiomarker('rn', 'RefNone', { reference: null }),
      makeBiomarker('rl', 'RefLow', { reference: intervalRef(1, 5) }),
      makeBiomarker('rle', 'RefLE', { reference: intervalRef(null, 3) }),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    fireEvent.click(headerButton(REFERENCE_HEADER))
    // One-sided bounds (no low) sort before bounded intervals; qualitative
    // text follows intervals; the missing reference is last.
    expectRowOrder(['RefLE', 'RefLow', 'RefHigh', 'RefQual', 'RefNone'])

    fireEvent.click(headerButton(REFERENCE_HEADER))
    expectRowOrder(['RefHigh', 'RefLow', 'RefLE', 'RefQual', 'RefNone'])
  })

  it('sorts unit labels alphabetically with empty units last', () => {
    const biomarkers = [
      makeBiomarker('ua', 'UnitA', { definition: defWith('ua', 'UnitA', { unit: 'g/L' }) }),
      makeBiomarker('ub', 'UnitB', { definition: defWith('ub', 'UnitB', { unit: 'mmol/L' }) }),
      makeBiomarker('uc', 'UnitC', { definition: defWith('uc', 'UnitC', { unit: '' }) }),
      makeBiomarker('ud', 'UnitD', {
        definition: defWith('ud', 'UnitD', { unit: 'x' }),
        reference: qualitativeRef('Negative'),
      }),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    fireEvent.click(headerButton(UNIT_HEADER))
    // Qualitative references display the "Qualitative" label — sorted with
    // the other unit texts; empty units stay last.
    expectRowOrder(['UnitA', 'UnitB', 'UnitD', 'UnitC'])

    fireEvent.click(headerButton(UNIT_HEADER))
    // Descending flips within the group: "Qualitative" (q) > "mmol/L" (m) >
    // "g/L" (g); the empty unit still stays last.
    expectRowOrder(['UnitD', 'UnitB', 'UnitA', 'UnitC'])
  })

  it('sorts original names by the displayed string (original_name, ru fallback)', () => {
    const biomarkers = [
      makeBiomarker('oa', 'Creatinine', { original_name: 'Холестерин' }, 'Креатинин'),
      makeBiomarker('ob', 'Albumin', {}, 'Альбумин'),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    fireEvent.click(headerButton(ORIGINAL_HEADER))
    expectRowOrder(['Albumin', 'Creatinine'])

    fireEvent.click(headerButton(ORIGINAL_HEADER))
    expectRowOrder(['Creatinine', 'Albumin'])
  })

  it('keeps merged section headers in place and sorts rows within each section', () => {
    const source = { title: 'Evening Panel', clinic: 'Invitro Lab', time: '18:30' }
    const biomarkers = [
      makeBiomarker('z', 'Zebra'),
      makeBiomarker('y', 'Yankee', { merged: true, merged_source: source }),
      makeBiomarker('a', 'Apple'),
      makeBiomarker('b', 'Bravo', { merged: true, merged_source: source }),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    fireEvent.click(headerButton(NAME_HEADER))
    // Sections stay anchored: originals first, then the merged header and its
    // rows — each section sorted internally.
    expectRowOrder(['Apple', 'Zebra', 'Evening Panel · 18:30', 'Bravo', 'Yankee'])
  })

  it('resets the sort when switching entries and restores it when returning', () => {
    const biomarkers = [
      makeBiomarker('z', 'Zebra'),
      makeBiomarker('a', 'Apple'),
      makeBiomarker('m', 'Mango'),
    ]
    const ui = (entryId: string) => (
      <TestI18nProvider>
        <ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" entryId={entryId} />
      </TestI18nProvider>
    )
    const { rerender } = render(ui('e1'))

    fireEvent.click(headerButton(NAME_HEADER))
    expectRowOrder(['Apple', 'Mango', 'Zebra'])

    // A different entry starts unsorted...
    rerender(ui('e2'))
    expectRowOrder(['Zebra', 'Apple', 'Mango'])
    expect(ariaSortOf(NAME_HEADER)).toBeNull()

    // ...and returning to the first entry restores its saved sort.
    rerender(ui('e1'))
    expectRowOrder(['Apple', 'Mango', 'Zebra'])
    expect(ariaSortOf(NAME_HEADER)).toBe('ascending')
  })

  it('applies the sort to the filtered list when searching', () => {
    const biomarkers = [
      makeBiomarker('hb', 'Hemoglobin'),
      makeBiomarker('ht', 'Hematocrit'),
      makeBiomarker('glu', 'Glucose'),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    fireEvent.change(screen.getByPlaceholderText('Search biomarkers...'), {
      target: { value: 'hem' },
    })
    expectRowOrder(['Hemoglobin', 'Hematocrit'])

    fireEvent.click(headerButton(NAME_HEADER))
    expectRowOrder(['Hematocrit', 'Hemoglobin'])
    expect(screen.queryByText('Glucose')).not.toBeInTheDocument()
  })

  it('does not sort when the sort state is null after a full cycle', () => {
    const biomarkers = [
      makeBiomarker('z', 'Zebra'),
      makeBiomarker('a', 'Apple'),
    ]
    renderI18n(<ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />)

    const btn = headerButton(VALUE_HEADER)
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)
    expectRowOrder(['Zebra', 'Apple'])
    expect(ariaSortOf(VALUE_HEADER)).toBeNull()
  })
})
