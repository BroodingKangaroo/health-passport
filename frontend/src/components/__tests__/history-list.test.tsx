import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { HistoryList } from '../health-passport/history-list'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { BiomarkerResult, MedicalEvent } from '@/lib/types'

// Wrap renders with the i18n context (English) — HistoryList uses useTranslations.
const renderI18n = ((ui: React.ReactElement, options?: Parameters<typeof render>[1]) =>
  render(<TestI18nProvider>{ui}</TestI18nProvider>, options)) as typeof render

const longClinicName =
  'Very Long Laboratory Name — Comprehensive Diagnostic Medical Testing Services Limited'

const eventWithLongClinic: MedicalEvent = {
  id: 'test-1',
  date: 'Jan 15, 2027',
  type: 'blood_test',
  title: 'Basic Metabolic Panel',
  clinic: longClinicName,
  attachments: [],
}

const visitEvent: MedicalEvent = {
  id: 'test-2',
  date: 'Feb 1, 2027',
  type: 'doctor_visit',
  title: 'Cardiology consultation',
  clinic: 'City Clinic',
  attachments: [],
}

const flaggedLabEvent: MedicalEvent = {
  id: 'lab-1',
  date: 'Mar 2, 2027',
  type: 'blood_test',
  title: 'Lipid Panel',
  clinic: 'City Lab',
  attachments: [],
}

const cleanLabEvent: MedicalEvent = {
  id: 'lab-2',
  date: 'Mar 3, 2027',
  type: 'blood_test',
  title: 'Basic Panel',
  clinic: 'City Lab',
  attachments: [],
}

function makeBiomarker(overrides: Partial<BiomarkerResult>): BiomarkerResult {
  return {
    id: 'hb',
    entry_id: 'lab-1',
    definition: {
      id: 'hb',
      names: { en: 'Hemoglobin', ru: 'Гемоглобин' },
      synonyms: [],
      category: 'Complete Blood Count',
      unit: 'g/L',
      reference: null,
      scope: 'global',
      reference_source: 'global',
    },
    value: 150,
    date: 'Mar 2, 2027',
    status: 'normal',
    ...overrides,
  }
}

describe('HistoryList', () => {
  it('truncates long clinic name in event card with hover tooltip', () => {
    renderI18n(
      <HistoryList
        events={[eventWithLongClinic]}
        selectedId=""
        onSelect={vi.fn()}
      />,
    )

    const clinicEl = screen.getByText(longClinicName)
    expect(clinicEl.className).toContain('truncate')
    expect(clinicEl.getAttribute('title')).toBe(longClinicName)
  })

  it('paints the icon bubble with the event-type color family', () => {
    const { container } = renderI18n(
      <HistoryList
        events={[eventWithLongClinic, visitEvent]}
        selectedId=""
        onSelect={vi.fn()}
      />,
    )

    expect(container.querySelector('.bg-event-blood-test-bg')).not.toBeNull()
    expect(container.querySelector('.bg-event-doctor-visit-bg')).not.toBeNull()
  })

  it('keeps the card shrinkable inside its column (min-w-0 on the row flex item)', () => {
    // Regression guard for the card-blowout bug: the card button is a flex
    // item of the row; without min-w-0 its automatic minimum size is the
    // truncated title's full nowrap width and a long title blows the card
    // out of the sidebar column (jsdom can't measure layout, so pin the
    // classes instead).
    const { container } = renderI18n(
      <HistoryList
        events={[eventWithLongClinic]}
        selectedId=""
        onSelect={vi.fn()}
      />,
    )

    const card = container.querySelector('button.rounded-xl')
    expect(card).not.toBeNull()
    expect(card?.className).toContain('min-w-0')
    expect(card?.querySelector('p.truncate')).not.toBeNull()
  })

  it('gives each rail node its type color and marks the selected node', () => {
    const { container } = renderI18n(
      <HistoryList
        events={[eventWithLongClinic, visitEvent]}
        selectedId="test-1"
        onSelect={vi.fn()}
      />,
    )

    expect(container.querySelector('.bg-event-blood-test')).not.toBeNull()
    expect(container.querySelector('.bg-event-doctor-visit')).not.toBeNull()
    // Selection is the primary accent ring, never a type color.
    expect(container.querySelector('.ring-2.ring-primary\\/40')).not.toBeNull()
  })

  it('shows compact filter chips with per-type counts that double as the legend', () => {
    renderI18n(
      <HistoryList
        events={[eventWithLongClinic, visitEvent]}
        selectedId=""
        onSelect={vi.fn()}
      />,
    )

    const group = screen.getByRole('group', { name: 'Entry Type' })
    expect(group).toBeInTheDocument()
    // Chips use the compact short labels (full labels live in the popover).
    expect(screen.getByText('All')).toBeInTheDocument()
    expect(screen.getByText('Labs')).toBeInTheDocument()
    expect(screen.getByText('Visits')).toBeInTheDocument()
  })

  it('keeps the chip row on a single non-wrapping line (rail/details alignment)', () => {
    const { container } = renderI18n(
      <HistoryList
        events={[eventWithLongClinic, visitEvent]}
        selectedId=""
        onSelect={vi.fn()}
      />,
    )

    const group = container.querySelector('[role="group"]')
    expect(group?.className).toContain('flex-nowrap')
    expect(group?.className).toContain('overflow-x-auto')
    expect(group?.className).not.toContain('flex-wrap')
  })

  it('renders zero-count type chips disabled instead of hiding them', () => {
    renderI18n(
      <HistoryList events={[visitEvent]} selectedId="" onSelect={vi.fn()} />,
    )

    const instrumental = screen.getByRole('button', { name: /Instrumental/ })
    const procedures = screen.getByRole('button', { name: /Procedures/ })
    // Still present as the type legend, but not interactive (filtering to
    // an empty type is a no-op).
    expect(instrumental).toHaveAttribute('aria-disabled', 'true')
    expect(procedures).toHaveAttribute('aria-disabled', 'true')
    expect(instrumental.getAttribute('title')).toBe('No records of this type yet')

    const labs = screen.getByRole('button', { name: /Labs/ })
    expect(labs).toHaveAttribute('aria-disabled', 'true')
    const visits = screen.getByRole('button', { name: /Visits/ })
    expect(visits.getAttribute('aria-disabled')).toBeNull()
  })

  it('shows the type-colored empty state when a single type filter has no matches', () => {
    const { container } = renderI18n(
      <HistoryList events={[visitEvent]} selectedId="" onSelect={vi.fn()} />,
    )

    // Zero-count chips are disabled, so the empty state is reached through
    // the filter popover: deselect every type except blood_test (of which
    // there are no events) until a single empty type remains.
    fireEvent.click(screen.getByRole('button', { name: 'Filter history' }))
    const popover = document.querySelector('.shadow-xl')!
    fireEvent.click(within(popover as HTMLElement).getByRole('button', { name: /Doctor Visits/ }))
    fireEvent.click(within(popover as HTMLElement).getByRole('button', { name: /Instrumental Tests/ }))
    fireEvent.click(within(popover as HTMLElement).getByRole('button', { name: /Procedures/ }))

    expect(screen.getByText('No matching records found')).toBeInTheDocument()
    // The empty state borrows the remaining type's color family.
    expect(container.querySelector('.bg-event-blood-test-bg')).not.toBeNull()
  })

  it('wraps long card titles to two lines instead of ellipsizing', () => {
    const longTitleEvent: MedicalEvent = {
      ...eventWithLongClinic,
      title:
        'Исследование состава микробиоты кишечника с определением чувствительности к бактериофагам',
    }
    const { container } = renderI18n(
      <HistoryList
        events={[longTitleEvent]}
        selectedId=""
        onSelect={vi.fn()}
      />,
    )

    const title = container.querySelector('p.line-clamp-2')
    expect(title).not.toBeNull()
    expect(title?.getAttribute('title')).toBe(longTitleEvent.title)
  })

  it('exposes the rail as a focusable region for keyboard scrolling', () => {
    renderI18n(
      <HistoryList
        events={[eventWithLongClinic, visitEvent]}
        selectedId=""
        onSelect={vi.fn()}
      />,
    )

    const region = screen.getByRole('region', { name: 'History' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(within(region).getByText('Basic Metabolic Panel')).toBeInTheDocument()
    expect(within(region).getByText('Cardiology consultation')).toBeInTheDocument()
  })

  it('shows compact flagged-result chips on blood-test cards', () => {
    renderI18n(
      <HistoryList
        events={[flaggedLabEvent, visitEvent]}
        selectedId=""
        onSelect={vi.fn()}
        biomarkers={[
          makeBiomarker({ id: 'a', status: 'high' }),
          makeBiomarker({ id: 'b', status: 'high' }),
          makeBiomarker({ id: 'c', status: 'low' }),
          makeBiomarker({ id: 'd', status: 'abnormal' }),
          makeBiomarker({ id: 'e', status: 'normal' }),
        ]}
      />,
    )

    expect(screen.getByTitle('2 high results')).toHaveTextContent('2')
    expect(screen.getByTitle('1 low result')).toHaveTextContent('1')
    expect(screen.getByTitle('1 abnormal result')).toHaveTextContent('1')
    expect(
      screen.getByText('Flagged results: 2 high results, 1 low result, 1 abnormal result'),
    ).toBeInTheDocument()
  })

  it('hides the chips when no reading is flagged or the entry is not a lab', () => {
    renderI18n(
      <HistoryList
        events={[cleanLabEvent, visitEvent]}
        selectedId=""
        onSelect={vi.fn()}
        biomarkers={[
          makeBiomarker({ entry_id: 'lab-2', status: 'normal' }),
          makeBiomarker({ entry_id: 'test-2', status: 'high' }),
        ]}
      />,
    )

    expect(screen.queryByTitle(/high result|low result|abnormal result/)).toBeNull()
    expect(screen.queryByText(/Flagged results/)).toBeNull()
  })

  it('filters to exactly the events that carry flagged chips', () => {
    renderI18n(
      <HistoryList
        events={[flaggedLabEvent, cleanLabEvent]}
        selectedId=""
        onSelect={vi.fn()}
        biomarkers={[
          makeBiomarker({ id: 'a', status: 'high' }),
          makeBiomarker({ id: 'b', entry_id: 'lab-2', status: 'normal' }),
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Filter history' }))
    const popover = document.querySelector('.shadow-xl')!
    fireEvent.click(within(popover as HTMLElement).getByRole('button', { name: /Abnormal Results/ }))

    expect(screen.getByText('Lipid Panel')).toBeInTheDocument()
    expect(screen.getByTitle('1 high result')).toBeInTheDocument()
    expect(screen.queryByText('Basic Panel')).not.toBeInTheDocument()
  })
})
