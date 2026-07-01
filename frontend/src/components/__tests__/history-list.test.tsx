import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HistoryList } from '../health-passport/history-list'
import type { MedicalEvent } from '@/lib/types'

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
    render(
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
