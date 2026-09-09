import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

  it('shows the type-colored empty state when a single type filter has no matches', () => {
    const { container } = renderI18n(
      <HistoryList events={[visitEvent]} selectedId="" onSelect={vi.fn()} />,
    )

    // Deselect every type except blood_test (of which there are no events):
    // chips toggle types off one by one until a single empty type remains.
    fireEvent.click(screen.getByRole('button', { name: /Visits/ }))
    fireEvent.click(screen.getByRole('button', { name: /Instrumental/ }))
    fireEvent.click(screen.getByRole('button', { name: /Procedures/ }))

    expect(screen.getByText('No matching records found')).toBeInTheDocument()
    // The empty state borrows the remaining type's color family.
    expect(container.querySelector('.bg-event-blood-test-bg')).not.toBeNull()
  })
})
