import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { NotificationBell, freshImportNotifications } from '../health-passport/notification-bell'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  dismissNotification,
  type NotificationItem,
} from '@/services/notifications'
import { retryImportJob } from '@/services/import-jobs'

const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}))
vi.mock('@/services/notifications', () => ({
  fetchNotifications: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
  dismissNotification: vi.fn(),
}))
vi.mock('@/services/import-jobs', () => ({
  retryImportJob: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

const fetchMock = vi.mocked(fetchNotifications)
const readAllMock = vi.mocked(markAllNotificationsRead)
const readOneMock = vi.mocked(markNotificationRead)
const dismissMock = vi.mocked(dismissNotification)
const retryMock = vi.mocked(retryImportJob)

function note(overrides: Partial<NotificationItem>): NotificationItem {
  return {
    id: 'n1',
    job_id: 'job-1',
    type: 'import_job_done',
    payload: { job_id: 'job-1', filename: 'lab.pdf' },
    read_at: null,
    created_at: '2026-09-05T10:00:00+00:00',
    ...overrides,
  }
}

function renderBell() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <TestI18nProvider>
        <NotificationBell />
      </TestI18nProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  pushMock.mockReset()
  readAllMock.mockResolvedValue(undefined)
  readOneMock.mockResolvedValue(undefined)
  dismissMock.mockResolvedValue(undefined)
  retryMock.mockResolvedValue(undefined)
})

describe('NotificationBell', () => {
  it('shows the unread badge and opens the dropdown listing items', async () => {
    fetchMock.mockResolvedValue({
      unread_count: 2,
      items: [
        note({ id: 'n1', type: 'import_job_done' }),
        note({ id: 'n2', type: 'import_job_failed', payload: { job_id: 'job-2', filename: 'bad.pdf' } }),
      ],
    })
    renderBell()
    await screen.findByTestId('bell-badge')
    expect(screen.getByTestId('bell-badge')).toHaveTextContent('2')
    fireEvent.click(screen.getByTestId('notification-bell'))
    // Opening clears the badge (read-all).
    await waitFor(() => expect(readAllMock).toHaveBeenCalled())
    expect(await screen.findByText('Document extracted')).toBeInTheDocument()
    expect(screen.getByText('Extraction failed')).toBeInTheDocument()
    expect(screen.getByText('lab.pdf')).toBeInTheDocument()
    expect(screen.getByText('bad.pdf')).toBeInTheDocument()
  })

  it('renders the empty state', async () => {
    fetchMock.mockResolvedValue({ unread_count: 0, items: [] })
    renderBell()
    fireEvent.click(await screen.findByTestId('notification-bell'))
    expect(await screen.findByText('No notifications')).toBeInTheDocument()
  })

  it('links a done item to the review page and marks it read on click', async () => {
    fetchMock.mockResolvedValue({
      unread_count: 1,
      items: [note({})],
    })
    renderBell()
    fireEvent.click(await screen.findByTestId('notification-bell'))
    const review = await screen.findByText('Review')
    expect(review.getAttribute('href')).toBe('/review-import?job=job-1')
    fireEvent.click(screen.getByText('lab.pdf'))
    await waitFor(() => expect(readOneMock).toHaveBeenCalledWith('n1'))
  })

  it('retries a failed item from the dropdown', async () => {
    fetchMock.mockResolvedValue({
      unread_count: 1,
      items: [note({ id: 'n2', type: 'import_job_failed', job_id: 'job-2' })],
    })
    renderBell()
    fireEvent.click(await screen.findByTestId('notification-bell'))
    const retry = await screen.findByText('Retry')
    fireEvent.click(retry)
    await waitFor(() => expect(retryMock).toHaveBeenCalledWith('job-2'))
  })

  it('dismisses an item', async () => {
    fetchMock.mockResolvedValue({
      unread_count: 0,
      items: [note({ id: 'n3' })],
    })
    renderBell()
    fireEvent.click(await screen.findByTestId('notification-bell'))
    fireEvent.click(await screen.findByText('Dismiss'))
    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith('n3'))
  })

})

describe('freshImportNotifications (coalescing decision)', () => {
  const older = '2026-09-05T10:00:00+00:00'
  const newer = '2026-09-05T10:01:00+00:00'

  it('null seen marker = nothing seen yet: every unread item is fresh', () => {
    const items = [note({ read_at: null }), note({ id: 'n2', read_at: null })]
    // (The component skips the helper entirely on its first load, so the
    // backlog is still never toasted — the marker is only null then.)
    expect(freshImportNotifications(items, null)).toHaveLength(2)
  })

  it('returns only unread items newer than the seen marker', () => {
    const items = [
      note({ id: 'n1', created_at: older, read_at: older }),
      note({ id: 'n2', created_at: newer }),
    ]
    expect(freshImportNotifications(items, older).map((n) => n.id)).toEqual(['n2'])
  })

  it('returns several items so the caller can coalesce into ONE summary toast', () => {
    const items = [
      note({ id: 'n1', created_at: newer }),
      note({ id: 'n2', created_at: '2026-09-05T10:02:00+00:00' }),
      note({ id: 'n3', created_at: '2026-09-05T10:03:00+00:00' }),
    ]
    expect(freshImportNotifications(items, older)).toHaveLength(3)
  })
})
