'use client'

import { useSession } from "next-auth/react"
import { useEffect } from "react"
import { setAccessToken } from "@/lib/auth-token"

export function AuthInitializer() {
  const { data: session } = useSession()

  setAccessToken(session?.accessToken ?? null)

  useEffect(() => {
    setAccessToken(session?.accessToken ?? null)
  }, [session?.accessToken])

  return null
}
