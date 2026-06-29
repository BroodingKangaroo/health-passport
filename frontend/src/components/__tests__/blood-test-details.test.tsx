import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BloodTestDetails } from '../health-passport/blood-test-details'
import type { MedicalEvent, BiomarkerResult } from '@/lib/types'

vi.mock('next/dynamic', () => ({
  default: (fn: () => Promise<{ DocumentViewer: React.ComponentType<{ url: string }> }>) => {
    const MockComponent = ({ url }: { url: string }) => (
      <div data-testid="document-viewer" data-url={url}>
        Document Viewer: {url}
      </div>
    )
    return MockComponent
  },
}))

const baseEvent: MedicalEvent = {
  id: 'test-event',
  date: 'Jan 15, 2027',
  type: 'blood_test',
  title: 'Test Panel',
  clinic: 'Test Lab',
  attachments: [
    { id: 'att-1', name: 'lab_report.pdf', type: 'Lab Report', size: '120 KB', url: '/static/uploads/lab.pdf' },
    { id: 'att-2', name: 'xray.png', type: 'X-Ray', size: '3 MB', url: '/static/uploads/xray.png' },
  ],
}

const eventNoAttachments: MedicalEvent = {
  ...baseEvent,
  attachments: [],
}

const emptyBiomarkers: BiomarkerResult[] = []

describe('BloodTestDetails', () => {
  it('renders DocumentViewer with the active attachment url', () => {
    render(<BloodTestDetails event={baseEvent} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} />)

    const documentsTab = screen.getByText('Documents (2)')
    fireEvent.click(documentsTab)

    const viewer = screen.getByTestId('document-viewer')
    expect(viewer).toHaveAttribute('data-url', '/static/uploads/lab.pdf')
  })

  it('switches DocumentViewer url when clicking a different attachment', () => {
    render(<BloodTestDetails event={baseEvent} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} />)

    const documentsTab = screen.getByText('Documents (2)')
    fireEvent.click(documentsTab)

    fireEvent.click(screen.getByText('xray.png'))

    const viewer = screen.getByTestId('document-viewer')
    expect(viewer).toHaveAttribute('data-url', '/static/uploads/xray.png')
  })

  it('shows empty state when no attachments', () => {
    render(<BloodTestDetails event={eventNoAttachments} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} />)

    const documentsTab = screen.getByText('Documents (0)')
    fireEvent.click(documentsTab)

    expect(screen.getByText('No documents available for this event.')).toBeDefined()
  })
})
