import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

const { useSessionMock, signOutMock, fetchCurrentUserMock, fetchAnonIdMock } = vi.hoisted(
  () => ({
    useSessionMock: vi.fn(),
    signOutMock: vi.fn(),
    fetchCurrentUserMock: vi.fn(),
    fetchAnonIdMock: vi.fn(),
  }),
)

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
