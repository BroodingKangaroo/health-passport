import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ShareLinkButton } from '@/components/share/sender/share-link-dialog'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { ShareLinkSummary } from '@/lib/share'

const createShareLink = vi.fn()
const listShareLinks = vi.fn()
const revokeShareLink = vi.fn()
const revokeAllShareLinks = vi.fn()

vi.mock('@/services/api', () => ({
  createShareLink: () => createShareLink(),
  listShareLinks: () => listShareLinks(),
  revokeShareLink: (id: string) => revokeShareLink(id),
  revokeAllShareLinks: () => revokeAllShareLinks(),
}))

const created = {
  id: 'link-1',
  token: 'hp_abc123',
  created_at: '2026-09-15T10:00:00+00:00',
  expires_at: '2026-09-22T10:00:00+00:00',
  scope: { kind: 'all' },
  include_header: true,
  include_notes: false,
}

const activeLink: ShareLinkSummary = {
  id: 'link-1',
  created_at: created.created_at,
  expires_at: created.expires_at,
  revoked_at: null,
  first_opened_at: null,
  is_anonymous: false,
  scope: { kind: 'all' },
  include_header: true,
  include_notes: false,
}

const renderButton = () =>
  render(
    <TestI18nProvider>
      <ShareLinkButton />
    </TestI18nProvider>,
  )

beforeEach(() => {
  createShareLink.mockReset()
  listShareLinks.mockReset()
  revokeShareLink.mockReset()
  revokeAllShareLinks.mockReset()
  listShareLinks.mockResolvedValue({ links: [] })
})

describe('ShareLinkButton', () => {
  it('creates a link and shows the URL exactly once, with the consequence spelled out', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()

    fireEvent.click(screen.getByRole('button', { name: 'Share a link' }))
    expect(await screen.findByText(/Anyone with this link can view your record/)).toBeInTheDocument()
    expect(screen.getByText(/including anyone it gets forwarded to/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    const link = await screen.findByText(/\/s\/hp_abc123$/)
    // The token is only ever offered as a copyable link — never as a stored,
    // re-displayable value on the sender's side.
    expect(link).toBeInTheDocument()
    expect(createShareLink).toHaveBeenCalledTimes(1)
  })

  it('lists the sender own links and revokes one on demand', async () => {
    listShareLinks
      .mockResolvedValueOnce({ links: [activeLink] })
      .mockResolvedValueOnce({
        links: [{ ...activeLink, revoked_at: '2026-09-16T10:00:00+00:00' }],
      })
    revokeShareLink.mockResolvedValue(undefined)
    renderButton()

    fireEvent.click(screen.getByRole('button', { name: 'Share a link' }))
    expect(await screen.findByText('Not opened yet')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('link-1'))
    // Once revoked, the row reports it and offers no further action.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument(),
    )
  })

  it('offers revoke-all whenever anything is still active', async () => {
    listShareLinks.mockResolvedValue({ links: [activeLink] })
    revokeAllShareLinks.mockResolvedValue({ revoked: 1 })
    renderButton()

    fireEvent.click(screen.getByRole('button', { name: 'Share a link' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke all' }))
    await waitFor(() => expect(revokeAllShareLinks).toHaveBeenCalledTimes(1))
  })
})
