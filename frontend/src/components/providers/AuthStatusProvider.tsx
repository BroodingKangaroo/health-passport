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

export function AuthStatusProvider({ children }: { children: ReactNode }) {
  const { data: session, status: sessionStatus } = useSession()
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [anonId, setAnonId] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const token = session?.accessToken
  const sessionReady = sessionStatus !== 'loading'

  useEffect(() => {
    let cancelled = false

    if (!sessionReady) {
      setStatus('loading')
      return
    }

    if (!token) {
      setStatus('unauthenticated')
      setUser(null)
      fetchAnonId()
        .then((id) => {
          if (!cancelled) setAnonId(id)
        })
        .catch(() => {
          if (!cancelled) setAnonId(null)
        })
      return
    }

    setAnonId(null)
    setStatus('loading')
    fetchCurrentUser(token)
      .then((me) => {
        if (cancelled) return
        if (me) {
          setUser(me)
          setStatus('authenticated')
        } else {
          // Token is invalid/expired on the backend but NextAuth still has a
          // session — clear it so the menu and data stay consistent.
          setUser(null)
          setStatus('unauthenticated')
          signOut({ callbackUrl: '/' })
        }
      })
      .catch(() => {
        if (cancelled) return
        setUser(null)
        setStatus('unauthenticated')
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, sessionReady, nonce])

  const refresh = () => setNonce((n) => n + 1)

  return (
    <AuthStatusContext.Provider value={{ status, user, anonId, refresh }}>
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
