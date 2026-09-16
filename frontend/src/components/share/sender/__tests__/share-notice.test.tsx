import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ShareNotice } from '@/components/share/sender/share-notice'
import { TestI18nProvider } from '@/test/i18n-test-provider'

const fetchShareNotice = vi.fn()
const ackShareNotice = vi.fn()

vi.mock('@/services/api', () => ({
  fetchShareNotice: () => fetchShareNotice(),
  ackShareNotice: () => ackShareNotice(),
}))

const session = vi.hoisted(() => ({
  current: { data: { user: { id: 'user-1' } }, status: 'authenticated' } as {
    data: { user: { id: string } } | null
    status: string
  },
}))
vi.mock('next-auth/react', () => ({ useSession: () => session.current }))

const renderNotice = () =>
  render(
    <TestI18nProvider>
      <ShareNotice />
    </TestI18nProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  session.current = { data: { user: { id: 'user-1' } }, status: 'authenticated' }
  fetchShareNotice.mockResolvedValue({ active_links: 2, show: true })
  ackShareNotice.mockResolvedValue({ success: true, acknowledged: 2 })
})

describe('ShareNotice', () => {
  it('renders nothing at all while the backend says there is nothing to say', async () => {
    fetchShareNotice.mockResolvedValue({ active_links: 2, show: false })
    renderNotice()

    // Wait for the read to land, then confirm the line never appeared.
    await waitFor(() => expect(fetchShareNotice).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('share-notice')).toBeNull()
  })

  it('reads the notice once and says how many links can see the new results', async () => {
    renderNotice()

    expect(
      await screen.findByText('2 active links can see your new results'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage links' })).toHaveAttribute(
      'href',
      '/settings',
    )
    expect(fetchShareNotice).toHaveBeenCalledTimes(1)
  })

  it('reads naturally for a single link', async () => {
    fetchShareNotice.mockResolvedValue({ active_links: 1, show: true })
    renderNotice()

    expect(
      await screen.findByText('1 active link can see your new results'),
    ).toBeInTheDocument()
  })

  it('acknowledges explicitly and hides itself, without a second read', async () => {
    renderNotice()

    fireEvent.click(await screen.findByTestId('share-notice-ack'))

    await waitFor(() => expect(ackShareNotice).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId('share-notice')).toBeNull())
    // Reading is never the acknowledgement.
    expect(fetchShareNotice).toHaveBeenCalledTimes(1)
  })

  it('stays visible when the acknowledgement fails', async () => {
    ackShareNotice.mockRejectedValue(new Error('POST /share/notice/ack failed'))
    renderNotice()

    fireEvent.click(await screen.findByTestId('share-notice-ack'))

    await waitFor(() => expect(ackShareNotice).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('share-notice')).toBeInTheDocument()
  })

  it('renders the Russian plural without falling over', async () => {
    render(
      <TestI18nProvider locale="ru">
        <ShareNotice />
      </TestI18nProvider>,
    )

    expect(
      await screen.findByText('Ваши новые результаты видят 2 активные ссылки'),
    ).toBeInTheDocument()
  })
})
