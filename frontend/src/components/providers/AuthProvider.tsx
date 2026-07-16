'use client'

import { SessionProvider } from "next-auth/react"
import { ReactNode } from "react"
import { AuthInitializer } from "./AuthInitializer"

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <AuthInitializer />
      {children}
    </SessionProvider>
  )
}