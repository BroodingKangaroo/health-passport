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
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [anonId, setAnonId] = useState<string | null>(null)
  const [authed, setAuthed] = useState(false)
  const [nonce, setNonce] = useState(0)

  const token = session?.accessToken ?? null

  // Reset the async resolution when the token changes. Adjusted during render
  // so we never need a synchronous setState in an effect (React 19 avoids
  // setState-in-effect for derived state like this).
  const [prevToken, setPrevToken] = useState(token)
  if (prevToken !== token) {
    setPrevToken(token)
    setAuthed(false)
    setUser(null)
    setAnonId(null)
  }

  const status: AuthStatus =
    sessionStatus === 'loading'
      ? 'loading'
      : token
        ? authed
          ? 'authenticated'
          : 'loading'
        : 'unauthenticated'

  useEffect(() => {
    if (sessionStatus === 'loading') return
    let cancelled = false

    if (token) {
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
          setUser(null)
          setAuthed(false)
        })
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
