'use client'

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { useSession, signOut } from 'next-auth/react'
import { fetchCurrentUser, fetchAnonId, type CurrentUser } from '@/services/api'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

interface AuthStatusContextValue {
  status: AuthStatus
  user: CurrentUser | null
  /** Anonymous session id when not authenticated. */
  anonId: string | null
  /** Re-check the backend token (e.g. after a login completes). */
  refresh: () => void
}

const AuthStatusContext = createContext<AuthStatusContextValue | null>(null)

// Bounded retries for the backend token verification: a transient network
// error or 5xx must not leave the header skeleton stuck on 'loading' forever
// (ISSUES.md #63). After the retries are exhausted the provider degrades to
// 'unauthenticated' (recoverable via refresh()/login).
const VERIFY_ATTEMPTS = 3
const VERIFY_RETRY_BASE_MS = 1500

export function AuthStatusProvider({ children }: { children: ReactNode }) {
  const { data: session, status: sessionStatus } = useSession()
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [anonId, setAnonId] = useState<string | null>(null)
  const [authed, setAuthed] = useState(false)
  // True when token verification failed for good (retries exhausted): the
  // status then degrades to 'unauthenticated' instead of a stuck skeleton.
  const [verifyFailed, setVerifyFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  const token = session?.accessToken ?? null

  // Reset the async resolution when the token changes. Adjusted during render
  // so we never need a synchronous setState in an effect (React 19 avoids
  // setState-in-effect for derived state like this).
  const [prevToken, setPrevToken] = useState(token)
  if (prevToken !== token) {
    setPrevToken(token)
    setAuthed(false)
    setVerifyFailed(false)
    setUser(null)
    setAnonId(null)
  }

  const status: AuthStatus =
    sessionStatus === 'loading'
      ? 'loading'
      : token
        ? authed
          ? 'authenticated'
          : verifyFailed
            ? 'unauthenticated'
            : 'loading'
        : 'unauthenticated'

  useEffect(() => {
    if (sessionStatus === 'loading') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    if (token) {
      const attempt = (left: number) => {
        fetchCurrentUser(token)
          .then((me) => {
            if (cancelled) return
            if (me) {
              setUser(me)
              setAuthed(true)
            } else {
              // Token is invalid/expired on the backend but NextAuth still has a
              // session — clear it so the menu and data stay consistent.
              setUser(null)
              setAuthed(false)
              signOut({ callbackUrl: '/' })
            }
          })
          .catch(() => {
            if (cancelled) return
            if (left > 1) {
              // Transient failure: retry with linear backoff…
              timer = setTimeout(
                () => attempt(left - 1),
                VERIFY_RETRY_BASE_MS * (VERIFY_ATTEMPTS - left + 1),
              )
            } else {
              // …then degrade to unauthenticated instead of a permanent
              // skeleton (ISSUES.md #63).
              setVerifyFailed(true)
              setUser(null)
              setAuthed(false)
            }
          })
      }
      attempt(VERIFY_ATTEMPTS)
    } else {
      fetchAnonId()
        .then((id) => {
          if (!cancelled) setAnonId(id)
        })
        .catch(() => {
          if (!cancelled) setAnonId(null)
        })
    }

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [token, sessionStatus, nonce])

  const refresh = () => setNonce((n) => n + 1)
  const visibleUser = status === 'authenticated' ? user : null

  return (
    <AuthStatusContext.Provider value={{ status, user: visibleUser, anonId, refresh }}>
      {children}
    </AuthStatusContext.Provider>
  )
}

export function useAuthStatus(): AuthStatusContextValue {
  const ctx = useContext(AuthStatusContext)
  if (!ctx) {
    throw new Error('useAuthStatus must be used within an AuthStatusProvider')
  }
  return ctx
}
