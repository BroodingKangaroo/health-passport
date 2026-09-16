import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { TestI18nProvider } from '@/test/i18n-test-provider'

/**
 * AuthStatusProvider sends a session the backend no longer accepts to
 * /login?session=expired. The page must explain why the user is looking at a
 * login form instead of appearing to have logged them out for no reason.
 */

const searchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParams,
}))

vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
}))

import LoginPage from '@/app/(app)/login/page'

function renderLogin() {
  return render(
    <TestI18nProvider>
      <LoginPage />
    </TestI18nProvider>,
  )
}

describe('login page session-expired notice', () => {
  beforeEach(() => {
    searchParams.delete('session')
    searchParams.delete('callbackUrl')
  })

  it('explains that the session ended when ?session=expired is present', () => {
    searchParams.set('session', 'expired')
    renderLogin()
    const notice = screen.getByTestId('session-expired-notice')
    expect(notice.textContent).toContain('Your session ended')
  })

  it('shows no notice on a plain visit to /login', () => {
    renderLogin()
    expect(screen.queryByTestId('session-expired-notice')).toBeNull()
  })
})
