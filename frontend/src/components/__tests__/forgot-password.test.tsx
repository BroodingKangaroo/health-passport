import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import ForgotPasswordPage from '@/app/forgot-password/page'
import { TestI18nProvider } from '@/test/i18n-test-provider'

const mockRequestPasswordReset = vi.fn()
const mockFetchEmailDeliveryEnabled = vi.fn()

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    requestPasswordReset: (...args: unknown[]) => mockRequestPasswordReset(...args),
    fetchEmailDeliveryEnabled: (...args: unknown[]) =>
      mockFetchEmailDeliveryEnabled(...args),
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const renderPage = () =>
  render(
    <TestI18nProvider>
      <ForgotPasswordPage />
    </TestI18nProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ForgotPasswordPage', () => {
  // The endpoint answers 200 for every address (no user enumeration), so it
  // can never report delivery problems. Instance-level "this deployment has no
  // mail transport" is the part that can be shown honestly — without it the
  // page promises an inbox that stays empty.
  it('warns when the instance cannot send email', async () => {
    mockFetchEmailDeliveryEnabled.mockResolvedValue(false)
    renderPage()
    await waitFor(() => {
      expect(screen.getByTestId('email-delivery-warning').textContent).toContain(
        'Email delivery is not configured',
      )
    })
  })

  it('stays quiet when email delivery is configured', async () => {
    mockFetchEmailDeliveryEnabled.mockResolvedValue(true)
    renderPage()
    await waitFor(() => {
      expect(mockFetchEmailDeliveryEnabled).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('email-delivery-warning')).toBeNull()
  })

  it('stays quiet when the capability probe fails', async () => {
    mockFetchEmailDeliveryEnabled.mockRejectedValue(new Error('down'))
    renderPage()
    await waitFor(() => {
      expect(mockFetchEmailDeliveryEnabled).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('email-delivery-warning')).toBeNull()
  })
})
