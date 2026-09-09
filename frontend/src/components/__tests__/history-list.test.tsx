import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { HistoryList } from '../health-passport/history-list'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { MedicalEvent } from '@/lib/types'

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
})
