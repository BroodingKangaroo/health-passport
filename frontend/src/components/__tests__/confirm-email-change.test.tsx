import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import ConfirmEmailChangePage from '@/app/confirm-email-change/page'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import { ApiError } from '@/services/api'

const mockConfirmEmailChange = vi.fn()

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    confirmEmailChange: (...args: unknown[]) => mockConfirmEmailChange(...args),
  }
})

const mockPush = vi.fn()
let searchParams = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchParams),
}))

const renderPage = () =>
  render(
    <TestI18nProvider>
      <ConfirmEmailChangePage />
    </TestI18nProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  searchParams = ''
})

describe('ConfirmEmailChangePage', () => {
  it('rejects a link without a token', () => {
    renderPage()
    expect(screen.getByRole('alert').textContent).toContain('invalid or has expired')
    expect(mockConfirmEmailChange).not.toHaveBeenCalled()
  })

  it('confirms the change only when the user clicks', async () => {
    searchParams = 'token=raw-token'
    mockConfirmEmailChange.mockResolvedValue(undefined)
    renderPage()

    // Nothing happens on load — a link preview fetching the page must not be
    // able to consume the one-time token.
    expect(mockConfirmEmailChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Confirm new email/i }))
    await waitFor(() => {
      expect(mockConfirmEmailChange).toHaveBeenCalledWith('raw-token')
    })
    expect(await screen.findByText(/Email updated/i)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Go to sign in' })).toBeDefined()
  })

  it('shows the backend error for an invalid or expired token', async () => {
    searchParams = 'token=stale'
    mockConfirmEmailChange.mockRejectedValue(
      new ApiError(400, 'Invalid or expired email confirmation link'),
    )
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /Confirm new email/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Invalid or expired')
    })
  })
})
