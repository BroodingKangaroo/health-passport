'use client'

import { SessionProvider } from "next-auth/react"
import { ReactNode } from "react"
import { AuthInitializer } from "./AuthInitializer"
import { AuthStatusProvider } from "./AuthStatusProvider"

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      {/* MUST stay BEFORE {children}: its token effect flushes ahead of the
          page subtree's query effects in the same commit, so the first
          session-gated fetch (useAuthPrincipal) already carries the bearer
          token. Moving it below would silently revive the anon-principal
          race on /imports. */}
      <AuthInitializer />
      <AuthStatusProvider>
        {children}
      </AuthStatusProvider>
    </SessionProvider>
  )
}