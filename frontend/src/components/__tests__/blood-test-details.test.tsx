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

const longLabName = 'Very Long Laboratory Name — Comprehensive Diagnostic Medical Testing Services Limited'

const eventWithLongLabName: MedicalEvent = {
  id: 'test-event',
  date: 'Jan 15, 2027',
  type: 'blood_test' as const,
  title: 'Test Panel',
  clinic: longLabName,
  attachments: [],
}

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

  it('keeps search input on same row and shows full lab name on hover when lab name is long', () => {
    render(<BloodTestDetails event={eventWithLongLabName} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} />)

    const searchInput = screen.getByPlaceholderText('Search biomarkers...')

    const headerContainer = searchInput.closest('.flex-nowrap')
    expect(headerContainer).toBeTruthy()

    const searchWrapper = headerContainer?.querySelector('.shrink-0')
    expect(searchWrapper).toBeTruthy()

    const subtitle = screen.getByText((content) => content.includes(longLabName))
    expect(subtitle.className).toContain('truncate')
    expect(subtitle.getAttribute('title')).toBe(`Jan 15, 2027 · ${longLabName}`)
  })

  it('renders a Settings tab and switches to it on click', () => {
    render(<BloodTestDetails event={baseEvent} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} onDeleted={vi.fn()} />)

    const settingsTab = screen.getByRole('button', { name: 'Settings' })
    expect(settingsTab).toBeDefined()
    fireEvent.click(settingsTab)

    // The Settings panel surfaces the entry type and a Danger Zone heading
    expect(screen.getByText('Entry Details')).toBeDefined()
    expect(screen.getByText('Danger Zone')).toBeDefined()
  })
})
