'use client'

import { SessionProvider } from "next-auth/react"
import { ReactNode } from "react"
import { AuthInitializer } from "./AuthInitializer"
import { AuthStatusProvider } from "./AuthStatusProvider"

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <AuthInitializer />
      <AuthStatusProvider>
        {children}
      </AuthStatusProvider>
    </SessionProvider>
  )
}