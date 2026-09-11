import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DoctorVisitDetails } from '../health-passport/doctor-visit-details'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { VisitData } from '@/lib/types'

// Wrap renders with the i18n context (English) and a QueryClient — the
// component uses useTranslations and EntrySettings (Settings tab) uses
// useQueryClient.
const renderI18n = ((ui: React.ReactElement, options?: Parameters<typeof render>[1]) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <TestI18nProvider>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </TestI18nProvider>,
    options,
  )
}) as typeof render

vi.mock('next/dynamic', () => ({
  default: () => {
    const MockComponent = ({ url, fill }: { url: string; fill?: boolean }) => (
      <div data-testid="document-viewer" data-url={url} data-fill={fill ? 'true' : 'false'}>
        Document Viewer: {url}
      </div>
    )
    return MockComponent
  },
}))

const baseVisit: VisitData = {
  specialty: 'Cardiology Follow-up',
  provider: 'Dr. Test',
  date: 'Jan 15, 2027',
  clinic: 'Heart Institute',
  verdict: { original: 'Hypertension', translated_en: 'Hypertension' },
  notes: [],
  prescriptions: [],
  recommendations: [],
  attachments: [
    { id: 'att-1', name: 'report.pdf', type: 'Lab Report', size: '120 KB', url: '/static/uploads/file1.pdf' },
    { id: 'att-2', name: 'scan.png', type: 'Diagnostic Image', size: '2 MB', url: '/static/uploads/file2.png' },
  ],
}

const TEST_ENTRY_ID = 'entry-7f2a9c31'

const visitNoUrl: VisitData = {
  ...baseVisit,
  attachments: [
    { id: 'att-1', name: 'report.pdf', type: 'Lab Report', size: '120 KB' },
  ],
}

describe('DoctorVisitDetails', () => {
  it('renders DocumentViewer with the active attachment url', () => {
    renderI18n(<DoctorVisitDetails visit={baseVisit} entryId={TEST_ENTRY_ID} />)

    const documentsTab = screen.getByText('Original Document (2)')
    fireEvent.click(documentsTab)

    const viewer = screen.getByTestId('document-viewer')
    expect(viewer).toHaveAttribute('data-url', '/static/uploads/file1.pdf')
    expect(viewer).toHaveAttribute('data-fill', 'true')
    expect(viewer.parentElement?.className).toContain('overflow-hidden')
  })

  it('switches DocumentViewer url when clicking a different attachment', () => {
    renderI18n(<DoctorVisitDetails visit={baseVisit} entryId={TEST_ENTRY_ID} />)

    const documentsTab = screen.getByText('Original Document (2)')
    fireEvent.click(documentsTab)

    fireEvent.click(screen.getByText('scan.png'))

    const viewer = screen.getByTestId('document-viewer')
    expect(viewer).toHaveAttribute('data-url', '/static/uploads/file2.png')
  })

  it('renders attachment chips with inline size and type/size tooltip', () => {
    renderI18n(<DoctorVisitDetails visit={baseVisit} entryId={TEST_ENTRY_ID} />)

    const documentsTab = screen.getByText('Original Document (2)')
    fireEvent.click(documentsTab)

    const reportChip = screen.getByText('report.pdf')
    expect(reportChip).toBeDefined()
    expect(reportChip.closest('button')?.getAttribute('title')).toBe('report.pdf · Lab Report · 120 KB')
    const scanChip = screen.getByText('scan.png')
    expect(scanChip).toBeDefined()
    expect(scanChip.closest('button')?.getAttribute('title')).toBe('scan.png · Diagnostic Image · 2 MB')
    expect(screen.getByText('120 KB')).toBeDefined()
    expect(screen.getByText('2 MB')).toBeDefined()
  })

  it('does not fall back to a hardcoded pdf when attachment has no url', () => {
    renderI18n(<DoctorVisitDetails visit={visitNoUrl} entryId={TEST_ENTRY_ID} />)

    const documentsTab = screen.getByText('Original Document (1)')
    fireEvent.click(documentsTab)

    const viewer = screen.getByTestId('document-viewer')
    expect(viewer).not.toHaveAttribute('data-url', '/attachment-preview.pdf')
    expect(viewer).not.toHaveAttribute('data-url', expect.stringContaining('attachment-preview'))

    // No real url => Print/Download actions are hidden
    expect(screen.queryByRole('button', { name: 'Print' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('renders a Settings tab and switches to it on click', () => {
    renderI18n(<DoctorVisitDetails visit={baseVisit} entryId={TEST_ENTRY_ID} onDeleted={vi.fn()} />)

    const settingsTab = screen.getByRole('button', { name: 'Settings' })
    expect(settingsTab).toBeDefined()
    fireEvent.click(settingsTab)

    expect(screen.getByText('Entry Details')).toBeDefined()
    expect(screen.getByText('Danger Zone')).toBeDefined()
  })

  it('uses the real entry id for the Settings delete/ID action', () => {
    renderI18n(<DoctorVisitDetails visit={baseVisit} entryId={TEST_ENTRY_ID} onDeleted={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    expect(screen.getByText(TEST_ENTRY_ID)).toBeDefined()
    expect(screen.queryByText(`${baseVisit.clinic}-${baseVisit.date}`)).toBeNull()
  })
})
