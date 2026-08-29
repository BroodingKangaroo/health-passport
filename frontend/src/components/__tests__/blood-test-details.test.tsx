import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BloodTestDetails } from '../health-passport/blood-test-details'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { MedicalEvent, BiomarkerResult } from '@/lib/types'

// Wrap renders with the i18n context (English) — StatusBadge uses useTranslations.
const renderI18n = ((ui: React.ReactElement, options?: Parameters<typeof render>[1]) =>
  render(<TestI18nProvider>{ui}</TestI18nProvider>, options)) as typeof render

vi.mock('next/dynamic', () => ({
  default: () => {
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
    renderI18n(<BloodTestDetails event={baseEvent} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} />)

    const documentsTab = screen.getByText('Documents (2)')
    fireEvent.click(documentsTab)

    const viewer = screen.getByTestId('document-viewer')
    expect(viewer).toHaveAttribute('data-url', '/static/uploads/lab.pdf')
  })

  it('switches DocumentViewer url when clicking a different attachment', () => {
    renderI18n(<BloodTestDetails event={baseEvent} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} />)

    const documentsTab = screen.getByText('Documents (2)')
    fireEvent.click(documentsTab)

    fireEvent.click(screen.getByText('xray.png'))

    const viewer = screen.getByTestId('document-viewer')
    expect(viewer).toHaveAttribute('data-url', '/static/uploads/xray.png')
  })

  it('shows empty state when no attachments', () => {
    renderI18n(<BloodTestDetails event={eventNoAttachments} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} />)

    const documentsTab = screen.getByText('Documents (0)')
    fireEvent.click(documentsTab)

    expect(screen.getByText('No documents available for this event.')).toBeDefined()
  })

  it('keeps search input on same row and shows full lab name on hover when lab name is long', () => {
    renderI18n(<BloodTestDetails event={eventWithLongLabName} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} />)

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
    renderI18n(<BloodTestDetails event={baseEvent} biomarkers={emptyBiomarkers} onViewDetails={vi.fn()} onDeleted={vi.fn()} />)

    const settingsTab = screen.getByRole('button', { name: 'Settings' })
    expect(settingsTab).toBeDefined()
    fireEvent.click(settingsTab)

    // The Settings panel surfaces the entry type and a Danger Zone heading
    expect(screen.getByText('Entry Details')).toBeDefined()
    expect(screen.getByText('Danger Zone')).toBeDefined()
  })

  describe('merged readings section', () => {
    function makeBiomarker(
      id: string,
      name: string,
      overrides: Partial<BiomarkerResult> = {},
    ): BiomarkerResult {
      return {
        id,
        definition: {
          id,
          names: { en: name, ru: name },
          synonyms: [],
          category: 'Complete Blood Count',
          unit: 'g/L',
          reference: null,
          scope: 'global',
          reference_source: 'global',
        },
        value: 150,
        entry_id: 'evt-blood',
        date: 'Jan 15, 2027',
        status: 'normal',
        ...overrides,
      }
    }

    it('groups merged readings under a header with the second test info', () => {
      const biomarkers: BiomarkerResult[] = [
        makeBiomarker('hb', 'Hemoglobin'),
        makeBiomarker('cre', 'Creatinine', {
          merged: true,
          merged_source: {
            title: 'Evening Panel',
            clinic: 'Invitro Lab',
            provider: 'Dr. Smith',
            time: '18:30',
          },
        }),
      ]
      renderI18n(<BloodTestDetails event={baseEvent} biomarkers={biomarkers} onViewDetails={vi.fn()} />)

      const header = screen.getByText('Evening Panel · 18:30')
      expect(header).toBeInTheDocument()
      expect(screen.getByText('Invitro Lab · Dr. Smith')).toBeInTheDocument()
      expect(screen.getByText('Added from a later upload on the same date')).toBeInTheDocument()
    })

    it('shows no merged section when every reading is original', () => {
      const biomarkers: BiomarkerResult[] = [
        makeBiomarker('hb', 'Hemoglobin'),
        makeBiomarker('glu', 'Glucose'),
      ]
      renderI18n(<BloodTestDetails event={baseEvent} biomarkers={biomarkers} onViewDetails={vi.fn()} />)

      expect(screen.queryByText('Added from a later upload on the same date')).not.toBeInTheDocument()
      expect(screen.getAllByText('Hemoglobin').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Glucose').length).toBeGreaterThan(0)
    })

    it('renders one section per distinct merge source', () => {
      const biomarkers: BiomarkerResult[] = [
        makeBiomarker('hb', 'Hemoglobin'),
        makeBiomarker('cre', 'Creatinine', {
          merged: true,
          merged_source: { title: 'Evening Panel', clinic: 'Invitro Lab', time: '18:30' },
        }),
        makeBiomarker('bun', 'Urea Nitrogen', {
          merged: true,
          merged_source: { title: 'Morning Follow-up', clinic: 'City Lab', provider: 'Dr. Day', time: '08:00' },
        }),
      ]
      renderI18n(<BloodTestDetails event={baseEvent} biomarkers={biomarkers} onViewDetails={vi.fn()} />)

      expect(screen.getByText('Evening Panel · 18:30')).toBeInTheDocument()
      expect(screen.getByText('Morning Follow-up · 08:00')).toBeInTheDocument()
      // Two sources → two "Added from a later upload" hints.
      expect(screen.getAllByText('Added from a later upload on the same date')).toHaveLength(2)
    })

    it('falls back to a generic label when the merged upload has no title', () => {
      const biomarkers: BiomarkerResult[] = [
        makeBiomarker('hb', 'Hemoglobin'),
        makeBiomarker('cre', 'Creatinine', {
          merged: true,
          merged_source: { time: '10:15' },
        }),
      ]
      renderI18n(<BloodTestDetails event={baseEvent} biomarkers={biomarkers} onViewDetails={vi.fn()} />)

      expect(screen.getByText('Merged readings · 10:15')).toBeInTheDocument()
    })

    it('renders the merged section alone when the entry has no original readings', () => {
      const biomarkers: BiomarkerResult[] = [
        makeBiomarker('cre', 'Creatinine', {
          merged: true,
          merged_source: { title: 'Evening Panel' },
        }),
      ]
      renderI18n(<BloodTestDetails event={baseEvent} biomarkers={biomarkers} onViewDetails={vi.fn()} />)

      expect(screen.getByText('Evening Panel')).toBeInTheDocument()
      expect(screen.getByText('Added from a later upload on the same date')).toBeInTheDocument()
    })
  })
})
