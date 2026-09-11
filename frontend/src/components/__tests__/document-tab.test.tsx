import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { DocumentTab } from '../health-passport/document-tab'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { EventAttachment } from '@/lib/types'

const { printAuthedDocument, fetchAuthedObjectUrl } = vi.hoisted(() => ({
  printAuthedDocument: vi.fn(),
  fetchAuthedObjectUrl: vi.fn(),
}))

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>()
  return { ...actual, printAuthedDocument, fetchAuthedObjectUrl }
})

vi.mock('next/dynamic', () => ({
  default: () => {
    const MockComponent = ({
      url,
      fill,
      actions,
    }: {
      url?: string
      fill?: boolean
      actions?: React.ReactNode
    }) => (
      <div data-testid="document-viewer" data-url={url} data-fill={fill ? 'true' : 'false'}>
        Document Viewer: {url}
        {actions}
      </div>
    )
    return MockComponent
  },
}))

const renderI18n = (ui: React.ReactElement) => render(<TestI18nProvider>{ui}</TestI18nProvider>)

const attachments: EventAttachment[] = [
  { id: 'att-1', name: 'report.pdf', type: 'Lab Report', size: '120 KB', url: '/static/uploads/report.pdf' },
  { id: 'att-2', name: 'scan.png', type: 'Diagnostic Image', size: '2 MB', url: '/static/uploads/scan.png' },
]

describe('DocumentTab', () => {
  beforeEach(() => {
    printAuthedDocument.mockReset()
    fetchAuthedObjectUrl.mockReset().mockResolvedValue('blob:mock-url')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  it('renders a chip per attachment with name and size, the first active, and the viewer', () => {
    renderI18n(<DocumentTab attachments={attachments} />)

    const reportChip = screen.getByText('report.pdf').closest('button')
    const scanChip = screen.getByText('scan.png').closest('button')
    expect(reportChip).toHaveAttribute('aria-pressed', 'true')
    expect(scanChip).toHaveAttribute('aria-pressed', 'false')
    expect(reportChip).toHaveAttribute('title', 'report.pdf · Lab Report · 120 KB')
    expect(screen.getByText('120 KB')).toBeDefined()
    expect(screen.getByText('2 MB')).toBeDefined()
    expect(screen.getByTestId('document-viewer')).toHaveAttribute('data-url', '/static/uploads/report.pdf')
    expect(screen.getByTestId('document-viewer')).toHaveAttribute('data-fill', 'true')
    expect(screen.getByTestId('document-viewer').parentElement?.className).toContain('overflow-hidden')
  })

  it('switches the active chip and viewer url on click', () => {
    renderI18n(<DocumentTab attachments={attachments} />)

    fireEvent.click(screen.getByText('scan.png'))

    expect(screen.getByText('scan.png').closest('button')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('report.pdf').closest('button')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('document-viewer')).toHaveAttribute('data-url', '/static/uploads/scan.png')
  })

  it('renders print/download inside the viewer chrome and prints the active url', () => {
    renderI18n(<DocumentTab attachments={attachments} />)

    const viewer = screen.getByTestId('document-viewer')
    fireEvent.click(within(viewer).getByRole('button', { name: 'Print' }))
    expect(printAuthedDocument).toHaveBeenCalledWith('/static/uploads/report.pdf')

    fireEvent.click(screen.getByText('scan.png'))
    fireEvent.click(within(screen.getByTestId('document-viewer')).getByRole('button', { name: 'Print' }))
    expect(printAuthedDocument).toHaveBeenLastCalledWith('/static/uploads/scan.png')
  })

  it('downloads the active attachment from the viewer chrome', () => {
    renderI18n(<DocumentTab attachments={attachments} />)

    fireEvent.click(within(screen.getByTestId('document-viewer')).getByRole('button', { name: 'Download' }))
    expect(fetchAuthedObjectUrl).toHaveBeenCalledWith('/static/uploads/report.pdf')
  })

  it('hides print/download and the viewer url for URL-less attachments', () => {
    renderI18n(
      <DocumentTab attachments={[{ id: 'att-1', name: 'report.pdf', type: 'Lab Report', size: '120 KB' }]} />,
    )

    expect(screen.getByText('report.pdf')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Print' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    expect(screen.getByTestId('document-viewer')).not.toHaveAttribute('data-url')
  })

  it('shows the empty state without attachments', () => {
    renderI18n(<DocumentTab attachments={[]} />)

    expect(screen.getByText('No documents available for this event.')).toBeDefined()
    expect(screen.queryByTestId('document-viewer')).toBeNull()
  })
})
