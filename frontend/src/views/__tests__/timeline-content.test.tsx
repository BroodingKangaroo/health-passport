import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TimelineContent } from '@/views/TimelineView'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { MedicalEvent, TimelineResponse } from '@/lib/types'

const bloodTest: MedicalEvent = {
  id: 'evt-1',
  date: 'Jan 15, 2027',
  type: 'blood_test',
  title: 'Test Panel',
  clinic: 'Test Lab',
  attachments: [],
}

const data: TimelineResponse = {
  events: [bloodTest],
  biomarkers: [],
  visits: {},
  instrumental: {},
}

describe('TimelineContent shell', () => {
  it('renders both panes with the newest event selected', () => {
    render(
      <TestI18nProvider>
        <TimelineContent data={data} isLoading={false} error={null} refetch={vi.fn()} />
      </TestI18nProvider>,
    )

    expect(screen.getByRole('region', { name: 'History' })).toBeInTheDocument()
    expect(screen.getByText('Test Panel')).toBeInTheDocument()
    expect(screen.getByText('Blood Test Results')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search biomarkers...')).toBeInTheDocument()
  })
})
