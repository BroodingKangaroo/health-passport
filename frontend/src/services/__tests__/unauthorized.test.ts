import { describe, it, expect, vi, afterEach } from 'vitest'

import { fetchTimelineEvents, setUnauthorizedHandler } from '@/services/api'
import { setAccessToken } from '@/lib/auth-token'

/**
 * The backend can reject a token that NextAuth still considers valid: it
 * expired, or the account bumped its session version (password change,
 * password reset, confirmed email change). Every fetch wrapper must then fire
 * the global re-auth hook that AuthStatusProvider registers, so the user lands
 * on /login instead of a page that keeps failing.
 */

function mockStatus(status: number): void {
  const res = {
    ok: false,
    status,
    statusText: 'Unauthorized',
    json: () => Promise.resolve({ detail: 'Your session has ended.' }),
  } as unknown as Response
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res)))
}

afterEach(() => {
  vi.unstubAllGlobals()
  setUnauthorizedHandler(null)
  setAccessToken(null)
})

describe('global 401 re-auth hook', () => {
  it('fires once for a 401 on a request that carried a token', async () => {
    setAccessToken('token-a')
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockStatus(401)

    await expect(fetchTimelineEvents()).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('stays silent when the request carried no token', async () => {
    // A 401 without a bearer token is a plain credential failure (e.g. a
    // wrong-password login), not a dead session.
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockStatus(401)

    await expect(fetchTimelineEvents()).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('fires only once per token across parallel failures and retries', async () => {
    setAccessToken('token-a')
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockStatus(401)

    await Promise.allSettled([
      fetchTimelineEvents(),
      fetchTimelineEvents(),
      fetchTimelineEvents(),
    ])
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('fires again for a different token', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockStatus(401)

    setAccessToken('token-a')
    await expect(fetchTimelineEvents()).rejects.toBeInstanceOf(Error)
    setAccessToken('token-b')
    await expect(fetchTimelineEvents()).rejects.toBeInstanceOf(Error)

    expect(onUnauthorized).toHaveBeenCalledTimes(2)
  })

  it('does not fire for non-401 failures', async () => {
    setAccessToken('token-a')
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    mockStatus(500)

    await expect(fetchTimelineEvents()).rejects.toMatchObject({ status: 500 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})
