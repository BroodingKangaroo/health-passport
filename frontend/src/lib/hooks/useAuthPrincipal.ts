'use client'

import { useSession } from 'next-auth/react'

/**
 * Session-readiness signal for authed data fetching.
 *
 * While next-auth is resolving the session on mount, the module-level access
 * token (`lib/auth-token.ts`) is still null — a fetch fired then would be
 * silently served by the ANONYMOUS principal (HTTP 200 + an empty list,
 * thanks to the backend's anon fallback) and cached until the next poll
 * tick. Callers must therefore gate their queries with `authReady` and
 * suffix their query keys with `uid`, so a login/logout switch can never
 * serve the previous principal's cached data (the same pattern
 * `useTimelineData`/`useFlowsheetData` already use).
 */
export function useAuthPrincipal() {
  const { data: session, status } = useSession()
  return {
    uid: session?.user?.id ?? 'anon',
    authReady: status !== 'loading',
  }
}
