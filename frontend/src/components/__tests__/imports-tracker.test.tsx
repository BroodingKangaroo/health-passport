import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from 'next-auth/react'

import { ImportsTracker } from '../health-passport/imports-tracker'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import {
  cancelImportJob,
  dismissImportJob,
  restoreImportJob,
  retryImportJob,
  fetchImportJobs,
  type ImportJobSummary,
} from '@/services/import-jobs'

const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
  usePathname: () => '/imports',
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/services/import-jobs', () => ({
  cancelImportJob: vi.fn(),
  retryImportJob: vi.fn(),
  dismissImportJob: vi.fn(),
  restoreImportJob: vi.fn(),
  fetchImportJobs: vi.fn(),
}))

const cancelMock = vi.mocked(cancelImportJob)
const retryMock = vi.mocked(retryImportJob)
const dismissMock = vi.mocked(dismissImportJob)
const restoreMock = vi.mocked(restoreImportJob)
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
    restorable: false,
    merge_conflicts: [],
    ...overrides,
  }
}

function renderTracker(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      {/* session={null} resolves next-auth's status to 'unauthenticated' —
          opens the useAuthPrincipal gate immediately. */}
      <SessionProvider session={null}>
        <TestI18nProvider>{ui}</TestI18nProvider>
      </SessionProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  cancelMock.mockResolvedValue(undefined)
  retryMock.mockResolvedValue(undefined)
  dismissMock.mockResolvedValue(undefined)
  restoreMock.mockResolvedValue(undefined)
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

  it('shows a loading skeleton instead of the empty state while pending', async () => {
    // Never-resolving fetch: the pre-hydration window must not flash the
    // "no documents" empty state (the reload pop-in bug).
    fetchJobsMock.mockImplementation(() => new Promise(() => {}))
    renderTracker(<ImportsTracker />)
    expect(screen.getByTestId('imports-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('imports-empty')).not.toBeInTheDocument()
  })

  it('lists active jobs with metadata and a collapsed history section', async () => {
    dismissMock.mockResolvedValue(undefined)
    fetchJobsMock.mockResolvedValue({
      items: [
        job({ id: 'job-a', status: 'processing', stage: 'extracting', original_filename: 'new.pdf' }),
        job({ id: 'job-b', status: 'done', original_filename: 'old.pdf' }),
        job({ id: 'job-c', status: 'failed', error: 'OCR quota exceeded (HTTP 429).' }),
        job({ id: 'job-d', status: 'cancelled', original_filename: 'gone.pdf' }),
        job({ id: 'job-e', status: 'saved', original_filename: 'done-saved.pdf' }),
        job({ id: 'job-f', status: 'dismissed', original_filename: 'dropped.pdf' }),
      ],
    })
    renderTracker(<ImportsTracker />)
    await screen.findByText('new.pdf')
    expect(screen.getByText('old.pdf')).toBeInTheDocument()
    expect(screen.getByText('Identifying medical data...')).toBeInTheDocument()
    expect(screen.getByText('OCR quota exceeded (HTTP 429).')).toBeInTheDocument()
    // History is COLLAPSED behind a toggle — nothing but the button shows.
    const toggle = screen.getByTestId('imports-history-toggle')
    expect(toggle).toHaveTextContent('Show earlier imports (3)')
    expect(screen.queryByTestId('imports-history-row')).toBeNull()
    // Expanding reveals the muted rows: cancelled/saved/dismissed, each
    // with a distinct status label.
    fireEvent.click(toggle)
    const historyRows = screen.getAllByTestId('imports-history-row')
    expect(historyRows).toHaveLength(3)
    expect(historyRows[0].textContent).toContain('gone.pdf')
    expect(historyRows[0].textContent).toContain('Cancelled')
    expect(historyRows[1].textContent).toContain('done-saved.pdf')
    expect(historyRows[1].textContent).toContain('Saved')
    expect(historyRows[2].textContent).toContain('dropped.pdf')
    expect(historyRows[2].textContent).toContain('Dismissed')
    // No buttons in non-restorable history rows.
    expect(historyRows[0].querySelector('button')).toBeNull()
    expect(historyRows[1].querySelector('button')).toBeNull()
    expect(historyRows[2].querySelector('button')).toBeNull()
    // Collapsing again hides the rows behind the toggle.
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByTestId('imports-history-row')).toBeNull())
    // Active done row: Review link + a Dismiss button (moves it to history).
    const doneRow = screen.getAllByTestId('imports-row').find((r) => r.textContent?.includes('old.pdf'))
    expect(doneRow!.querySelector('[data-testid="row-review"]')).not.toBeNull()
    const doneDismiss = Array.from(doneRow!.querySelectorAll('button')).find((b) => b.textContent === 'Dismiss')
    expect(doneDismiss).toBeTruthy()
    fireEvent.click(doneDismiss!)
    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith('job-b'))
    // Metadata line: plain time + size — no duplicated status word (#4).
    const metas = screen.getAllByTestId('row-meta')
    expect(metas.length).toBeGreaterThanOrEqual(3)
    expect(metas[0].textContent).not.toMatch(/Submitted|Extracted|Failed|Saved/)
    expect(metas[0].textContent).toMatch(/KB|MB/)
  })

  it('auto-expands the history for restorable dismissed rows and restores on click', async () => {
    restoreMock.mockResolvedValue(undefined)
    fetchJobsMock.mockResolvedValue({
      items: [
        job({ id: 'job-g', status: 'saved', original_filename: 'kept.pdf' }),
        job({ id: 'job-h', status: 'dismissed', restorable: true, original_filename: 'revive.pdf' }),
      ],
    })
    renderTracker(<ImportsTracker />)
    // No explicit toggle needed: a restorable dismissed row forces the
    // section open so Restore is discoverable.
    const restoreBtn = await screen.findByTestId('row-restore')
    expect(restoreBtn).toHaveTextContent('Restore')
    expect(restoreBtn.closest('li')!.textContent).toContain('revive.pdf')
    fireEvent.click(restoreBtn)
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith('job-h'))
  })

  it('warns on done rows whose record overlaps a same-date entry', async () => {
    fetchJobsMock.mockResolvedValue({
      items: [
        job({
          id: 'job-overlap',
          status: 'done',
          original_filename: 'overlap.pdf',
          merge_conflicts: ['Glucose', 'Hemoglobin'],
        }),
        job({ id: 'job-clean', status: 'done', original_filename: 'clean.pdf' }),
      ],
    })
    renderTracker(<ImportsTracker />)
    await screen.findByText('overlap.pdf')
    // One concise line: a count + hover tooltip with the full analyte list.
    const warning = screen.getByTestId('row-merge-warning')
    expect(warning.textContent).toContain('2 existing biomarkers')
    expect(warning.textContent).toContain('merging will be blocked')
    expect(warning).toHaveAttribute('title', 'Glucose, Hemoglobin')
    const cleanRow = screen
      .getAllByTestId('imports-row')
      .find((r) => r.textContent?.includes('clean.pdf'))
    expect(cleanRow!.querySelector('[data-testid="row-merge-warning"]')).toBeNull()
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

  it('badges freshly submitted jobs as new until each is opened (#76 rework)', async () => {
    sessionStorage.setItem(
      'imports_new_job_ids',
      JSON.stringify(['job-run', 'job-done']),
    )
    fetchJobsMock.mockResolvedValue({
      items: [
        job({ id: 'job-run', status: 'queued', original_filename: 'run.pdf' }),
        job({ id: 'job-done', status: 'done', original_filename: 'done.pdf' }),
        job({ id: 'job-old', status: 'done', original_filename: 'old.pdf' }),
      ],
    })
    renderTracker(<ImportsTracker />)
    const rows = await screen.findAllByTestId('imports-row')
    expect(rows).toHaveLength(3)
    // Only the two submitted-but-unopened jobs carry the New pill.
    const badged = rows.filter((r) => r.querySelector('[data-testid="row-new"]'))
    expect(badged).toHaveLength(2)
    expect(
      badged.every(
        (r) => r.textContent?.includes('run.pdf') || r.textContent?.includes('done.pdf'),
      ),
    ).toBe(true)

    // Opening the in-flight job's progress view consumes its badge.
    fireEvent.click(screen.getByText('run.pdf'))
    await waitFor(() =>
      expect(sessionStorage.getItem('imports_new_job_ids')).toBe(
        JSON.stringify(['job-done']),
      ),
    )
    fireEvent.click(await screen.findByText('Back to upload'))
    const rowsAfter = await screen.findAllByTestId('imports-row')
    const runRow = rowsAfter.find((r) => r.textContent?.includes('run.pdf'))
    const doneRow = rowsAfter.find((r) => r.textContent?.includes('done.pdf'))
    expect(runRow!.querySelector('[data-testid="row-new"]')).toBeNull()
    expect(doneRow!.querySelector('[data-testid="row-new"]')).not.toBeNull()
  })

  it('opening a done job consumes its badge and routes to the review editor', async () => {
    sessionStorage.setItem('imports_new_job_ids', JSON.stringify(['job-done']))
    fetchJobsMock.mockResolvedValue({
      items: [job({ id: 'job-done', status: 'done', original_filename: 'done.pdf' })],
    })
    renderTracker(<ImportsTracker />)
    fireEvent.click(await screen.findByTestId('imports-row'))
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith('/review-import?job=job-done'),
    )
    await waitFor(() => expect(sessionStorage.getItem('imports_new_job_ids')).toBeNull())
  })
})
