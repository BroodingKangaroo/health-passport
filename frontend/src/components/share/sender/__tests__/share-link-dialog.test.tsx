import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ShareLinkButton } from '@/components/share/sender/share-link-dialog'
import { TestI18nProvider } from '@/test/i18n-test-provider'

const createShareLink = vi.fn()

vi.mock('@/services/api', () => ({
  createShareLink: (input: unknown) => createShareLink(input),
}))

// `useAuthPrincipal` reads the next-auth session: an authenticated session is a
// registered sender, a resolved null session is an anonymous one.
const session = vi.hoisted(() => ({
  current: { data: null, status: 'unauthenticated' } as {
    data: { user: { id: string } } | null
    status: string
  },
}))
vi.mock('next-auth/react', () => ({ useSession: () => session.current }))

const created = {
  id: 'link-1',
  token: 'hp_abc123',
  created_at: '2026-09-15T10:00:00+00:00',
  expires_at: '2026-09-22T10:00:00+00:00',
  scope: { kind: 'all' as const },
  include_header: true,
}

const renderButton = () =>
  render(
    <TestI18nProvider>
      <ShareLinkButton />
    </TestI18nProvider>,
  )

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Share a link' }))
}

beforeEach(() => {
  createShareLink.mockReset()
  // Registered by default: the anonymous variant is the exception and sets it.
  session.current = { data: { user: { id: 'user-1' } }, status: 'authenticated' }
})

describe('ShareLinkButton', () => {
  it('creates a link with the chosen scope, expiry and header, and shows the URL exactly once', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()
    openDialog()

    expect(await screen.findByText(/Anyone with this link can view your record/)).toBeInTheDocument()
    expect(screen.getByText(/including anyone it gets forwarded to/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Date range' }))
    fireEvent.change(screen.getByTestId('share-scope-from'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByTestId('share-scope-to'), { target: { value: '2026-03-31' } })
    fireEvent.click(screen.getByRole('radio', { name: '30 days' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(createShareLink).toHaveBeenCalledWith({
        expiry_days: 30,
        scope: { kind: 'range', from: '2026-01-01', to: '2026-03-31' },
        include_header: true,
      }),
    )

    const link = await screen.findByText(/\/s\/hp_abc123$/)
    // The token is only ever offered as a copyable link — never as a stored,
    // re-displayable value on the sender's side.
    expect(link).toBeInTheDocument()
    expect(createShareLink).toHaveBeenCalledTimes(1)
  })

  it('sends the whole record by default and honours a cleared header checkbox', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()
    openDialog()

    // The header defaults ON (S6); clearing it must travel as an explicit false.
    fireEvent.click(await screen.findByTestId('share-include-header'))
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(createShareLink).toHaveBeenCalledWith({
        expiry_days: 7,
        scope: null,
        include_header: false,
      }),
    )
  })

  it('sends an open-ended range when only one end is filled in', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()
    openDialog()

    fireEvent.click(screen.getByRole('radio', { name: 'Date range' }))
    fireEvent.change(screen.getByTestId('share-scope-from'), { target: { value: '2026-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(createShareLink).toHaveBeenCalledWith({
        expiry_days: 7,
        scope: { kind: 'range', from: '2026-01-01', to: null },
        include_header: true,
      }),
    )
  })

  it('refuses an inverted range instead of letting the request come back refused', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()
    openDialog()

    fireEvent.click(screen.getByRole('radio', { name: 'Date range' }))
    fireEvent.change(screen.getByTestId('share-scope-from'), { target: { value: '2026-03-31' } })
    fireEvent.change(screen.getByTestId('share-scope-to'), { target: { value: '2026-01-01' } })

    expect(await screen.findByText('The end date must be after the start date.')).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Create link' })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(createShareLink).not.toHaveBeenCalled()
  })

  it('offers 1, 7 and 30 days to a registered sender, with no cookie warning', async () => {
    renderButton()
    openDialog()

    expect(await screen.findByRole('radio', { name: '1 day' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '7 days' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '30 days' })).toBeInTheDocument()
    expect(screen.queryByText(/You are not signed in/)).toBeNull()
  })

  it('offers only 1 and 7 days to an anonymous sender, and says why', async () => {
    session.current = { data: null, status: 'unauthenticated' }
    renderButton()
    openDialog()

    expect(await screen.findByRole('radio', { name: '1 day' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '7 days' })).toBeInTheDocument()
    // S4: the server refuses 30 days for an anonymous principal, so the dialog
    // must never imply it is available.
    expect(screen.queryByRole('radio', { name: '30 days' })).toBeNull()
    expect(screen.getByText(/You are not signed in/)).toBeInTheDocument()
    expect(screen.getByText(/these links can no longer be revoked/)).toBeInTheDocument()
  })

  it('has no notes toggle — entry notes never travel', async () => {
    renderButton()
    openDialog()

    await screen.findByRole('button', { name: 'Create link' })
    expect(screen.queryByText(/notes/i)).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /notes/i })).toBeNull()
  })

  it('renders the Russian dialog copy (ICU plurals included)', async () => {
    session.current = { data: null, status: 'unauthenticated' }
    render(
      <TestI18nProvider locale="ru">
        <ShareLinkButton />
      </TestI18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Поделиться ссылкой' }))
    expect(await screen.findByRole('radio', { name: '7 дней' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '1 день' })).toBeInTheDocument()
    expect(screen.getByText(/Вы не вошли в аккаунт/)).toBeInTheDocument()
  })
})
