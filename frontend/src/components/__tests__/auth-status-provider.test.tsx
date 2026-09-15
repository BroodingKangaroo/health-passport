import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

const {
  useSessionMock,
  signOutMock,
  fetchCurrentUserMock,
  fetchAnonIdMock,
  setUnauthorizedHandlerMock,
} = vi.hoisted(() => ({
  useSessionMock: vi.fn(),
  signOutMock: vi.fn(),
  fetchCurrentUserMock: vi.fn(),
  fetchAnonIdMock: vi.fn(),
  setUnauthorizedHandlerMock: vi.fn(),
}))

vi.mock('next-auth/react', () => ({
  useSession: useSessionMock,
  signOut: signOutMock,
}))

vi.mock('@/services/api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    fetchCurrentUser: fetchCurrentUserMock,
    fetchAnonId: fetchAnonIdMock,
    setUnauthorizedHandler: setUnauthorizedHandlerMock,
  }
})

import { AuthStatusProvider, useAuthStatus } from '@/components/providers/AuthStatusProvider'

function StatusProbe() {
  const { status } = useAuthStatus()
  return <div data-testid="status">{status}</div>
}

function renderProvider() {
  return render(
    <AuthStatusProvider>
      <StatusProbe />
    </AuthStatusProvider>,
  )
}

describe('AuthStatusProvider transient failure recovery (ISSUES.md #63)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSessionMock.mockReturnValue({ data: null, status: 'authenticated' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('recovers to authenticated after a transient fetch rejection', async () => {
    const token = 'tok'
    useSessionMock.mockReturnValue({
      data: { accessToken: token },
      status: 'authenticated',
    })
    fetchCurrentUserMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ id: 'u1', email: 'a@b.c', name: 'A', external_id: 'HP-1' })

    renderProvider()
    // First attempt failed; the backoff retry (1.5s) recovers — must NOT be
    // stuck on loading.
    await waitFor(
      () => expect(screen.getByTestId('status').textContent).toBe('authenticated'),
      { timeout: 4000 },
    )
    expect(fetchCurrentUserMock).toHaveBeenCalledTimes(2)
    expect(signOutMock).not.toHaveBeenCalled()
  }, 10_000)

  it('degrades to unauthenticated after repeated failures instead of sticking on loading', async () => {
    vi.useFakeTimers()
    const token = 'tok'
    useSessionMock.mockReturnValue({
      data: { accessToken: token },
      status: 'authenticated',
    })
    let calls = 0
    fetchCurrentUserMock.mockImplementation(() => {
      calls += 1
      return Promise.reject(new Error('network down'))
    })

    render(
      <AuthStatusProvider>
        <StatusProbe />
      </AuthStatusProvider>,
    )

    // Exhaust the bounded retries by flushing the backoff timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    expect(calls).toBe(3)
    expect(screen.getByTestId('status').textContent).toBe('unauthenticated')
    expect(signOutMock).not.toHaveBeenCalled()
  })

  it('anonymous sessions still resolve without a token', async () => {
    useSessionMock.mockReturnValue({ data: null, status: 'authenticated' })
    fetchAnonIdMock.mockResolvedValue('anon-123')

    renderProvider()
    await waitFor(() =>
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated'),
    )
    expect(fetchAnonIdMock).toHaveBeenCalled()
  })
})

describe('AuthStatusProvider re-auth path (roadmap 0.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends a backend-rejected session to /login with an explanation', async () => {
    useSessionMock.mockReturnValue({
      data: { accessToken: 'stale-token' },
      status: 'authenticated',
    })
    // NextAuth still holds a session, but the backend 401s the token (it
    // expired, or a password/email change retired it).
    fetchCurrentUserMock.mockResolvedValue(null)

    renderProvider()

    await waitFor(() =>
      expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/login?session=expired' }),
    )
    // The header keeps its skeleton until the NextAuth session clears (the
    // signOut redirect carries the user to /login); it must NOT flip to a
    // signed-in state for a token the backend already rejected.
    expect(screen.getByTestId('status').textContent).not.toBe('authenticated')
  })

  it('registers a global 401 handler that signs out to /login', async () => {
    useSessionMock.mockReturnValue({ data: null, status: 'authenticated' })
    fetchAnonIdMock.mockResolvedValue('anon-123')

    renderProvider()
    await waitFor(() => expect(setUnauthorizedHandlerMock).toHaveBeenCalled())

    const handler = setUnauthorizedHandlerMock.mock.calls[0][0] as () => void
    expect(typeof handler).toBe('function')
    handler()
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/login?session=expired' })
  })
})
