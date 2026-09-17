import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'

import { ShareLinksCard } from '@/components/share/sender/share-links-card'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { ShareLinkSummary } from '@/lib/share'

const listShareLinks = vi.fn()
const revokeShareLink = vi.fn()
const revokeAllShareLinks = vi.fn()

vi.mock('@/services/api', () => ({
  listShareLinks: () => listShareLinks(),
  revokeShareLink: (id: string) => revokeShareLink(id),
  revokeAllShareLinks: () => revokeAllShareLinks(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const session = vi.hoisted(() => ({
  current: { data: { user: { id: 'user-1' } }, status: 'authenticated' } as {
    data: { user: { id: string } } | null
    status: string
  },
}))
vi.mock('next-auth/react', () => ({ useSession: () => session.current }))

function link(overrides: Partial<ShareLinkSummary>): ShareLinkSummary {
  return {
    id: 'link-1',
    created_at: '2026-09-01T10:00:00+00:00',
    expires_at: '2026-09-08T10:00:00+00:00',
    revoked_at: null,
    first_opened_at: null,
    open_count: 0,
    last_opened_at: null,
    is_anonymous: false,
    scope: { kind: 'all' },
    include_header: true,
    default_locale: null,
    requires_passcode: false,
    state: 'active',
    has_new_data: false,
    ...overrides,
  }
}

const renderCard = () =>
  render(
    <TestI18nProvider>
      <ShareLinksCard />
    </TestI18nProvider>,
  )

async function rows() {
  return screen.findAllByTestId('share-link-row')
}

beforeEach(() => {
  vi.clearAllMocks()
  session.current = { data: { user: { id: 'user-1' } }, status: 'authenticated' }
  listShareLinks.mockResolvedValue({ links: [] })
})

describe('ShareLinksCard - Stage 4 markers', () => {
  it('marks a protected link, and only that one (S15)', async () => {
    listShareLinks.mockResolvedValue({
      links: [
        link({ id: 'plain', requires_passcode: false }),
        link({ id: 'locked', requires_passcode: true }),
      ],
    })
    renderCard()

    const rows = await screen.findAllByTestId('share-link-row')
    expect(within(rows[0]).queryByTestId('share-protected')).not.toBeInTheDocument()
    expect(within(rows[1]).getByTestId('share-protected')).toBeInTheDocument()
    // The card learns only THAT a passcode exists — never the code.
    expect(within(rows[1]).getByTestId('share-protected')).toHaveTextContent('Passcode')
  })

  it('shows the exclusions in words beside the scope (S16)', async () => {
    listShareLinks.mockResolvedValue({
      links: [
        link({ id: 'partial', scope: { kind: 'all', exclude: ['instrumental_test'] } }),
        link({ id: 'full', scope: { kind: 'all' } }),
      ],
    })
    renderCard()

    const rows = await screen.findAllByTestId('share-link-row')
    expect(within(rows[0]).getByTestId('share-exclusions')).toHaveTextContent(
      'Without: imaging and other tests',
    )
    // A whole-record link says nothing about exclusions.
    expect(within(rows[1]).queryByTestId('share-exclusions')).not.toBeInTheDocument()
  })

  it('shows exclusions on a date-ranged link too, because they ride both kinds', async () => {
    listShareLinks.mockResolvedValue({
      links: [
        link({
          id: 'ranged',
          scope: {
            kind: 'range',
            from: '2026-01-01',
            to: '2026-03-31',
            exclude: ['blood_test', 'doctor_visit'],
          },
        }),
      ],
    })
    renderCard()

    const row = (await screen.findAllByTestId('share-link-row'))[0]
    expect(within(row).getByTestId('share-scope')).toHaveTextContent('–')
    expect(within(row).getByTestId('share-exclusions')).toHaveTextContent(
      'Without: lab results, doctor visits',
    )
  })
})

describe('ShareLinksCard', () => {
  it('renders the state the SERVER computed, never one derived from the dates', async () => {
    listShareLinks.mockResolvedValue({
      links: [
        // Long past, still called active by the server.
        link({ id: 'a', state: 'active', expires_at: '2020-01-01T10:00:00+00:00' }),
        // Still in the future, already called expired by the server.
        link({ id: 'e', state: 'expired', expires_at: '2099-01-01T10:00:00+00:00' }),
        link({
          id: 'r',
          state: 'revoked',
          revoked_at: '2026-09-02T10:00:00+00:00',
          expires_at: '2099-01-09T10:00:00+00:00',
        }),
      ],
    })
    renderCard()

    const rendered = await rows()
    expect(rendered.map((row) => row.dataset.state)).toEqual(['active', 'expired', 'revoked'])
    expect(within(rendered[0]).getByText('Active')).toBeInTheDocument()
    expect(within(rendered[1]).getByText('Expired')).toBeInTheDocument()
    expect(within(rendered[2]).getByText('Revoked')).toBeInTheDocument()
    // Only the row the server calls active offers the action.
    expect(within(rendered[0]).getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
    expect(within(rendered[1]).queryByRole('button', { name: 'Revoke' })).toBeNull()
    expect(within(rendered[2]).queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  it('shows the empty state when nothing was ever shared', async () => {
    renderCard()

    expect(await screen.findByTestId('share-links-empty')).toHaveTextContent(
      'You have not shared this record yet.',
    )
    expect(screen.queryByTestId('share-link-row')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke all' })).toBeNull()
  })

  it('reports the open count and last open, singular copy included', async () => {
    listShareLinks.mockResolvedValue({
      links: [
        link({
          id: 'many',
          open_count: 3,
          first_opened_at: '2026-09-09T10:00:00+00:00',
          last_opened_at: '2026-09-12T10:00:00+00:00',
        }),
        link({ id: 'one', open_count: 1, last_opened_at: '2026-09-12T10:00:00+00:00' }),
        link({ id: 'never' }),
      ],
    })
    renderCard()

    const rendered = await rows()
    expect(within(rendered[0]).getByText(/Opened 3 times · last Sep 12, 2026/)).toBeInTheDocument()
    expect(within(rendered[1]).getByText(/Opened once · last Sep 12, 2026/)).toBeInTheDocument()
    expect(within(rendered[2]).getByText('Not opened yet')).toBeInTheDocument()
  })

  it('says the scope in words, open ends included', async () => {
    listShareLinks.mockResolvedValue({
      links: [
        link({ id: 'all', scope: { kind: 'all' } }),
        link({ id: 'range', scope: { kind: 'range', from: '2026-01-01', to: '2026-03-31' } }),
        link({ id: 'from', scope: { kind: 'range', from: '2026-01-01', to: null } }),
        link({ id: 'until', scope: { kind: 'range', from: null, to: '2026-03-31' } }),
      ],
    })
    renderCard()

    const rendered = await rows()
    expect(within(rendered[0]).getByText('Whole record')).toBeInTheDocument()
    // The range is one string with both ends, in the sender's locale.
    expect(within(rendered[1]).getByText(/Jan 1, 2026 . Mar 31, 2026/)).toBeInTheDocument()
    expect(within(rendered[2]).getByText('From Jan 1, 2026')).toBeInTheDocument()
    expect(within(rendered[3]).getByText('Until Mar 31, 2026')).toBeInTheDocument()
  })

  it('shows the sender which language a link is pinned to', async () => {
    listShareLinks.mockResolvedValue({
      links: [
        link({ id: 'ru', default_locale: 'ru' }),
        link({ id: 'en', default_locale: 'en' }),
        link({ id: 'auto', default_locale: null }),
      ],
    })
    renderCard()

    const rendered = await rows()
    expect(within(rendered[0]).getByTestId('share-language')).toHaveTextContent(
      'Language: Russian',
    )
    expect(within(rendered[1]).getByTestId('share-language')).toHaveTextContent(
      'Language: English',
    )
    // No preset, no line: the recipient's browser decides.
    expect(within(rendered[2]).queryByTestId('share-language')).toBeNull()
  })

  it('marks a row whose link can already see newer results', async () => {
    listShareLinks.mockResolvedValue({
      links: [link({ id: 'a', has_new_data: true }), link({ id: 'b' })],
    })
    renderCard()

    const rendered = await rows()
    expect(
      within(rendered[0]).getByText('New results since you shared'),
    ).toBeInTheDocument()
    expect(within(rendered[1]).queryByTestId('share-new-data')).toBeNull()
  })

  it('revokes one link and re-reads the list so the row reports the server state', async () => {
    listShareLinks
      .mockResolvedValueOnce({ links: [link({ id: 'link-1' })] })
      .mockResolvedValueOnce({
        links: [link({ id: 'link-1', state: 'revoked', revoked_at: '2026-09-16T10:00:00+00:00' })],
      })
    revokeShareLink.mockResolvedValue(undefined)
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))

    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('link-1'))
    await waitFor(() => expect(listShareLinks).toHaveBeenCalledTimes(2))
    const rendered = await rows()
    expect(rendered[0].dataset.state).toBe('revoked')
    expect(within(rendered[0]).queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  it('revokes everything only after a confirmation, and only while something is active', async () => {
    listShareLinks
      .mockResolvedValueOnce({ links: [link({ id: 'a' }), link({ id: 'b', state: 'expired' })] })
      .mockResolvedValue({
        links: [link({ id: 'a', state: 'revoked' }), link({ id: 'b', state: 'expired' })],
      })
    revokeAllShareLinks.mockResolvedValue({ revoked: 1 })
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke all' }))
    // Nothing happens until the confirmation is explicit.
    expect(revokeAllShareLinks).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByTestId('share-revoke-all-confirm-button'))

    await waitFor(() => expect(revokeAllShareLinks).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Revoked 1 active link.'))
    // Nothing is active any more, so the action disappears.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Revoke all' })).toBeNull(),
    )
  })

  it('hides revoke-all when every link is already dead', async () => {
    listShareLinks.mockResolvedValue({
      links: [link({ id: 'e', state: 'expired' }), link({ id: 'r', state: 'revoked' })],
    })
    renderCard()

    await rows()
    expect(screen.queryByRole('button', { name: 'Revoke all' })).toBeNull()
  })

  it('renders the Russian copies (ICU plurals included) without falling over', async () => {
    listShareLinks.mockResolvedValue({
      links: [
        link({
          id: 'ru',
          open_count: 2,
          last_opened_at: '2026-09-12T10:00:00+00:00',
          scope: { kind: 'range', from: '2026-01-01', to: '2026-03-31' },
        }),
      ],
    })
    render(
      <TestI18nProvider locale="ru">
        <ShareLinksCard />
      </TestI18nProvider>,
    )

    const rendered = await rows()
    expect(within(rendered[0]).getByText(/Открывали 2 раза/)).toBeInTheDocument()
    expect(within(rendered[0]).getByText(/последнее открытие/)).toBeInTheDocument()
    // Both ends of the range, in the sender's locale.
    const scope = within(rendered[0]).getByTestId('share-scope')
    expect(scope).toHaveTextContent(/янв/)
    expect(scope).toHaveTextContent(/мар/)
    expect(scope).toHaveTextContent(/2026/)
  })
})
