import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
