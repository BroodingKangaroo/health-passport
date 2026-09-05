import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ImportsTracker } from '../health-passport/imports-tracker'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import {
  cancelImportJob,
  dismissImportJob,
  retryImportJob,
  fetchImportJobs,
  type ImportJobSummary,
} from '@/services/import-jobs'

const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
  usePathname: () => '/imports',
}))
vi.mock('@/services/import-jobs', () => ({
  cancelImportJob: vi.fn(),
  retryImportJob: vi.fn(),
  dismissImportJob: vi.fn(),
  fetchImportJobs: vi.fn(),
}))

const cancelMock = vi.mocked(cancelImportJob)
const retryMock = vi.mocked(retryImportJob)
const dismissMock = vi.mocked(dismissImportJob)
const fetchJobsMock = vi.mocked(fetchImportJobs)

function job(overrides: Partial<ImportJobSummary>): ImportJobSummary {
  return {
    id: 'job-1',
    status: 'queued',
    stage: '',
    progress: null,
    original_filename: 'a.pdf',
    file_size: 10,
    created_at: null,
    updated_at: null,
    error: null,
    ...overrides,
  }
}

function renderTracker(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <TestI18nProvider>{ui}</TestI18nProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  cancelMock.mockResolvedValue(undefined)
  retryMock.mockResolvedValue(undefined)
  dismissMock.mockResolvedValue(undefined)
})

describe('ImportsTracker', () => {
  it('renders the empty state with an add-entry link', async () => {
    fetchJobsMock.mockResolvedValue({ items: [] })
    renderTracker(<ImportsTracker />)
    expect(await screen.findByTestId('imports-empty')).toBeInTheDocument()
    expect(screen.getByText('No documents in progress — import one.')).toBeInTheDocument()
    expect(screen.getByText('Import a document').closest('a')).toHaveAttribute(
      'href',
      '/add-entry',
    )
  })

  it('lists active jobs with status labels + metadata, history separately', async () => {
    fetchJobsMock.mockResolvedValue({
      items: [
        job({ id: 'job-a', status: 'processing', stage: 'extracting', original_filename: 'new.pdf' }),
        job({ id: 'job-b', status: 'done', original_filename: 'old.pdf' }),
        job({ id: 'job-c', status: 'failed', error: 'OCR quota exceeded (HTTP 429).' }),
        job({ id: 'job-d', status: 'cancelled', original_filename: 'gone.pdf' }),
        job({ id: 'job-e', status: 'saved', original_filename: 'done-saved.pdf' }),
      ],
    })
    renderTracker(<ImportsTracker />)
    await screen.findByText('new.pdf')
    expect(screen.getByText('old.pdf')).toBeInTheDocument()
    expect(screen.getByText('Identifying medical data...')).toBeInTheDocument()
    expect(screen.getByText('OCR quota exceeded (HTTP 429).')).toBeInTheDocument()
    // Saved/cancelled live in the muted history section, not the active list.
    expect(screen.getByTestId('imports-history-title')).toHaveTextContent('Earlier imports')
    const historyRows = screen.getAllByTestId('imports-history-row')
    expect(historyRows).toHaveLength(2)
    expect(historyRows[0].textContent).toContain('gone.pdf')
    expect(historyRows[0].textContent).toContain('Cancelled')
    expect(historyRows[1].textContent).toContain('done-saved.pdf')
    expect(historyRows[1].textContent).toContain('Saved')
    // Metadata line: status time + file size.
    const metas = screen.getAllByTestId('row-meta')
    expect(metas.length).toBeGreaterThanOrEqual(3)
    expect(metas[0].textContent).toMatch(/KB|MB/)
  })

  it('renders the in-flight progress view with the shared upload-screen visuals', async () => {
    fetchJobsMock.mockResolvedValue({
      items: [
        job({
          status: 'processing',
          stage: 'matching',
          progress: { stage: 'matching', biomarker_count: 3, estimate_s: 3 },
        }),
      ],
    })
    renderTracker(<ImportsTracker />)
    fireEvent.click(await screen.findByTestId('imports-row'))
    await screen.findByTestId('import-progress-view')
    // Same stage label + step text + eta as the upload screen.
    expect(screen.getByText('Standardizing results...')).toBeInTheDocument()
    expect(screen.getByText(/Step 3 of 3/)).toBeInTheDocument()
    expect(screen.getByText(/~3s remaining/)).toBeInTheDocument()
  })

  it('clicking a done job routes to the review editor', async () => {
    fetchJobsMock.mockResolvedValue({ items: [job({ status: 'done' })] })
    renderTracker(<ImportsTracker />)
    fireEvent.click(await screen.findByTestId('imports-row'))
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith('/review-import?job=job-1'),
    )
  })

  it('clicking an in-flight job opens the extraction-process view', async () => {
    fetchJobsMock.mockResolvedValue({
      items: [job({ status: 'processing', stage: 'matching', progress: { stage: 'matching', estimate_s: 3 } })],
    })
    renderTracker(<ImportsTracker />)
    fireEvent.click(await screen.findByTestId('imports-row'))
    expect(await screen.findByTestId('import-progress-view')).toBeInTheDocument()
    expect(screen.getByText('Standardizing results...')).toBeInTheDocument()
  })

  it('an in-flight job completing in view auto-advances to the review editor', async () => {
    fetchJobsMock.mockResolvedValue({ items: [job({ status: 'queued' })] })
    renderTracker(<ImportsTracker />)
    fireEvent.click(await screen.findByTestId('imports-row'))
    await screen.findByTestId('import-progress-view')
    // The shared 3s poll returns the completed job; the in-view transition
    // fires without any user action.
    fetchJobsMock.mockResolvedValue({ items: [job({ status: 'done' })] })
    await waitFor(
      () => expect(pushMock).toHaveBeenCalledWith('/review-import?job=job-1'),
      { timeout: 6000 },
    )
  })

  it('offers retry/dismiss for failed and cancel for in-flight rows', async () => {
    fetchJobsMock.mockResolvedValue({
      items: [
        job({ id: 'job-fail', status: 'failed', error: 'boom' }),
        job({ id: 'job-run', status: 'queued', original_filename: 'run.pdf' }),
      ],
    })
    renderTracker(<ImportsTracker />)
    await screen.findByText('boom')
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(retryMock).toHaveBeenCalledWith('job-fail'))
    fireEvent.click(screen.getByText('Dismiss'))
    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith('job-fail'))
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith('job-run'))
  })
})
