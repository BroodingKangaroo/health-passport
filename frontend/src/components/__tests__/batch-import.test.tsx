import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { BatchImportPanel } from '../health-passport/batch-import'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import {
  createImportJob,
  cancelImportJob,
  retryImportJob,
  dismissImportJob,
  fetchImportJobs,
  type ImportJobSummary,
} from '@/services/import-jobs'
import { fetchUsageLimits, ApiError } from '@/services/api'
import type { UsageLimits } from '@/lib/types'

vi.mock('@/services/import-jobs', () => ({
  createImportJob: vi.fn(),
  cancelImportJob: vi.fn(),
  retryImportJob: vi.fn(),
  dismissImportJob: vi.fn(),
  fetchImportJobs: vi.fn(),
}))
vi.mock('@/services/api', () => ({
  fetchUsageLimits: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message)
    }
  },
}))

const createMock = vi.mocked(createImportJob)
const cancelMock = vi.mocked(cancelImportJob)
const retryMock = vi.mocked(retryImportJob)
const dismissMock = vi.mocked(dismissImportJob)
const fetchJobsMock = vi.mocked(fetchImportJobs)
const limitsMock = vi.mocked(fetchUsageLimits)

function file(name: string): File {
  return new File(['x'], name, { type: 'application/pdf' })
}

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

function limits(overrides: Partial<UsageLimits> = {}): UsageLimits {
  return {
    is_anonymous: false,
    ai_extraction_count: 0,
    ai_extraction_limit: 50,
    total_upload_size_bytes: 0,
    total_upload_limit_bytes: 1,
    ...overrides,
  }
}

function renderPanel(ui: ReactNode) {
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
  fetchJobsMock.mockResolvedValue({ items: [] })
  limitsMock.mockResolvedValue(limits())
})

describe('BatchImportPanel', () => {
  it('submits one job per file and renders a row per file', async () => {
    createMock.mockResolvedValue('job-1')
    renderPanel(
      <BatchImportPanel files={[file('a.pdf'), file('b.pdf')]} onBack={vi.fn()} />,
    )
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('a.pdf')).toBeInTheDocument()
    expect(screen.getByText('b.pdf')).toBeInTheDocument()
    expect(screen.getByTestId('batch-overall')).toHaveTextContent('0 of 2 ready')
  })

  it('shows the anonymous quota notice and caps submission at the remaining quota', async () => {
    limitsMock.mockResolvedValue(
      limits({ is_anonymous: true, ai_extraction_count: 3, ai_extraction_limit: 5 }),
    )
    createMock.mockResolvedValue('job-x')
    renderPanel(
      <BatchImportPanel
        files={[file('a.pdf'), file('b.pdf'), file('c.pdf')]}
        onBack={vi.fn()}
      />,
    )
    // Capped: only the remaining 2 are submitted, never a doomed third.
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2))
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.pdf' }))
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'b.pdf' }))
    expect(createMock).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'c.pdf' }))
    // Anon pre-flight notice + over-limit rows stay picked, not fired.
    expect(screen.getByTestId('anon-quota-notice')).toHaveTextContent(
      'You can import up to 5 documents without an account',
    )
    await screen.findByText(/1 document exceeds your remaining quota/)
  })

  it('stops submitting after a submit failure instead of stacking more', async () => {
    createMock.mockRejectedValueOnce(new ApiError(500, 'boom'))
    renderPanel(
      <BatchImportPanel files={[file('a.pdf'), file('b.pdf')]} onBack={vi.fn()} />,
    )
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledTimes(1)
    await screen.findByText(/boom/)
  })

  it('renders live stage labels + eta from polled job progress', async () => {
    createMock.mockResolvedValue('job-1')
    // The shared poll returns a processing job at the matching stage.
    fetchJobsMock.mockResolvedValue({
      items: [
        job({
          id: 'job-1',
          status: 'processing',
          stage: 'matching',
          progress: { stage: 'matching', biomarker_count: 3, estimate_s: 4.2 },
        }),
      ],
    })
    renderPanel(<BatchImportPanel files={[file('a.pdf')]} onBack={vi.fn()} />)
    // Same stage visuals as the upload screen, driven by job progress.
    await screen.findByText(/^Standardizing results\.\.\./)
    expect(screen.getByText(/≈ 4s/)).toBeInTheDocument()
    expect(screen.getByTestId('batch-overall')).toHaveTextContent('0 of 1 ready')
  })

  it('shows the completion panel with review/track links when everything is done', async () => {
    createMock.mockResolvedValue('job-1')
    fetchJobsMock.mockResolvedValue({
      items: [job({ id: 'job-1', status: 'done' })],
    })
    renderPanel(<BatchImportPanel files={[file('a.pdf')]} onBack={vi.fn()} />)
    await screen.findByTestId('batch-complete')
    expect(screen.getByText('1 document extracted — review it')).toBeInTheDocument()
    expect(screen.getByText('Review now').closest('a')).toHaveAttribute(
      'href',
      '/review-import?job=job-1',
    )
    expect(screen.getByText('Track remaining extractions').closest('a')).toHaveAttribute(
      'href',
      '/imports',
    )
  })

  it('offers cancel for in-flight rows', async () => {
    createMock.mockResolvedValue('job-1')
    fetchJobsMock.mockResolvedValue({ items: [job({ id: 'job-1', status: 'queued' })] })
    renderPanel(<BatchImportPanel files={[file('a.pdf')]} onBack={vi.fn()} />)
    await screen.findByRole('button', { name: 'Cancel' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith('job-1'))
  })

  it('offers retry (with the backend-localized error) and remove for failed rows', async () => {
    createMock.mockResolvedValue('job-1')
    fetchJobsMock.mockResolvedValue({
      items: [job({ id: 'job-1', status: 'failed', error: 'OCR quota exceeded (HTTP 429).' })],
    })
    renderPanel(<BatchImportPanel files={[file('a.pdf')]} onBack={vi.fn()} />)
    await screen.findByText('OCR quota exceeded (HTTP 429).')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(retryMock).toHaveBeenCalledWith('job-1'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith('job-1'))
  })

  it('arms a beforeunload prompt only while submissions are in flight', async () => {
    let resolveLimits: (v: UsageLimits) => void = () => {}
    limitsMock.mockReturnValue(
      new Promise<UsageLimits>((res) => {
        resolveLimits = res
      }),
    )
    createMock.mockResolvedValue('job-1')
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderPanel(
      <BatchImportPanel files={[file('a.pdf')]} onBack={vi.fn()} />,
    )
    // In flight (limits fetch pending): the plain beforeunload prompt is armed.
    await waitFor(() =>
      expect(added.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true),
    )
    resolveLimits(limits())
    await waitFor(() => expect(createMock).toHaveBeenCalled())
    unmount()
    expect(removed.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true)
  })
})
