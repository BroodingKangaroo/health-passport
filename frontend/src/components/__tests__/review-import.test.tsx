import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { StandardizedMedicalRecord } from '@/lib/types'

const pushMock = vi.fn()
const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

const capturedAddEntryProps: Array<Record<string, unknown>> = []

vi.mock('@/components/health-passport/add-entry', () => ({
  AddEntry: (props: Record<string, unknown>) => {
    capturedAddEntryProps.push(props)
    return <div data-testid="add-entry-stub" />
  },
}))

vi.mock('@/components/health-passport/header-bar', () => ({
  HeaderBar: () => <div data-testid="header-bar-stub" />,
}))
vi.mock('@/services/import-jobs', () => ({
  fetchImportJob: vi.fn(),
  fetchImportJobs: vi.fn(),
  dismissImportJob: vi.fn(),
  fetchImportJobFile: vi.fn(),
}))

import { ReviewImport } from '../health-passport/review-import'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import {
  fetchImportJob,
  dismissImportJob,
  fetchImportJobFile,
  type ImportJobDetail,
} from '@/services/import-jobs'

const jobDetailMock = vi.mocked(fetchImportJob)
const jobFileMock = vi.mocked(fetchImportJobFile)
const dismissMock = vi.mocked(dismissImportJob)

function detail(overrides: Partial<ImportJobDetail>): ImportJobDetail {
  return {
    id: 'job-1',
    status: 'done',
    stage: '',
    progress: null,
    original_filename: 'lab.pdf',
    file_size: 10,
    created_at: null,
    error: null,
    result: {
      entry_type: 'blood_test',
      date: '2026-01-15',
      title: 'Annual panel',
      biomarkers: [],
    } as unknown as StandardizedMedicalRecord,
    error_key: null,
    error_params: null,
    updated_at: null,
    ...overrides,
  }
}

function renderReview(jobId?: string) {
  if (jobId !== undefined) window.history.replaceState(null, '', `/review-import?job=${jobId}`)
  else window.history.replaceState(null, '', '/review-import')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TestI18nProvider>
        <ReviewImport />
      </TestI18nProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedAddEntryProps.length = 0
  dismissMock.mockResolvedValue(undefined)
  jobFileMock.mockResolvedValue(new Blob(['%PDF fake'], { type: 'application/pdf' }))
})

describe('ReviewImport', () => {
  it('prefills the editor from the staged record of a done job', async () => {
    jobDetailMock.mockResolvedValue(detail({}))
    renderReview('job-1')
    await waitFor(() =>
      expect(capturedAddEntryProps.some((p) => p.stagedJob)).toBe(true),
    )
    const props = capturedAddEntryProps.find((p) => p.stagedJob)!
    expect((props.stagedJob as { jobId: string }).jobId).toBe('job-1')
    expect((props.stagedJob as { record: StandardizedMedicalRecord }).record.date).toBe(
      '2026-01-15',
    )
  })

  it('fetches the staged document for the preview pane', async () => {
    jobDetailMock.mockResolvedValue(detail({}))
    renderReview('job-1')
    await waitFor(() => {
      // The file lands on a LATER render (after the blob fetch resolves).
      const props = [...capturedAddEntryProps].reverse().find((p) => p.stagedJob)
      expect(props && (props.stagedJob as { file?: File | null }).file).toBeTruthy()
    })
    expect(jobFileMock).toHaveBeenCalledWith('job-1')
  })

  it('returns to /imports after save (no auto-advance)', async () => {
    jobDetailMock.mockResolvedValue(detail({ id: 'job-1' }))
    renderReview('job-1')
    await waitFor(() => expect(capturedAddEntryProps.some((p) => p.stagedJob)).toBe(true))
    const onSave = capturedAddEntryProps.find((p) => p.stagedJob)!.onSave as () => Promise<void>
    await onSave()
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/imports'))
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('cancel leaves the job staged and returns to /imports without the saved toast', async () => {
    jobDetailMock.mockResolvedValue(detail({ id: 'job-1' }))
    renderReview('job-1')
    await waitFor(() => expect(capturedAddEntryProps.some((p) => p.stagedJob)).toBe(true))
    const props = capturedAddEntryProps.find((p) => p.stagedJob)!
    const onCancel = props.onCancel as () => Promise<void>
    expect(typeof onCancel).toBe('function')
    await onCancel()
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/imports'))
  })

  it('renders the standard page chrome (header + back to imports)', async () => {
    jobDetailMock.mockResolvedValue(detail({ id: 'job-1' }))
    renderReview('job-1')
    expect(await screen.findByTestId('header-bar-stub')).toBeInTheDocument()
    await screen.findByText('Imports') // back nav label (trackerTitle)
  })

  it('shows an honest gone-state with dismiss for a failed job', async () => {
    jobDetailMock.mockResolvedValue(
      detail({ status: 'failed', result: null, error: 'OCR failed' }),
    )
    renderReview('job-1')
    await screen.findByTestId('review-gone')
    fireEvent.click(screen.getByText('Dismiss'))
    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith('job-1'))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/imports'))
  })

  it('shows the gone-state for a missing/unknown job id', async () => {
    jobDetailMock.mockRejectedValue(new Error('404'))
    renderReview('no-such-job')
    await screen.findByTestId('review-gone')
    expect(screen.getByText(/no longer available/)).toBeInTheDocument()
  })

  it('routes still-processing jobs to the tracker', async () => {
    jobDetailMock.mockResolvedValue(detail({ status: 'processing', result: null }))
    renderReview('job-1')
    await screen.findByTestId('review-still-processing')
    fireEvent.click(screen.getByText('View all imports'))
    expect(pushMock).toHaveBeenCalledWith('/imports')
  })

  it('shows the gone-state without a job id at all', async () => {
    renderReview()
    await screen.findByTestId('review-gone')
    expect(jobDetailMock).not.toHaveBeenCalled()
  })
})
