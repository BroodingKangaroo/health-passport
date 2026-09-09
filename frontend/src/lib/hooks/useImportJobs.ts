'use client'

import { useQuery } from '@tanstack/react-query'

import { fetchImportJobs } from '@/services/import-jobs'
import { useAuthPrincipal } from '@/lib/hooks/useAuthPrincipal'

/**
 * Shared import-jobs poll: ONE react-query key family (`['import-jobs', uid]`)
 * consumed by the /imports tracker; /add-entry's post-submit invalidation
 * surfaces fresh jobs without waiting for the next tick (prefix-matched).
 * Polls ~3s while mounted and refetches on window focus (iOS Safari suspends
 * JS in background tabs; all catch-ups must surface on resume). The fetch is
 * GATED on session readiness (`useAuthPrincipal`): mounting fires before
 * next-auth resolves the bearer token, and a tokenless request would be
 * answered by the anonymous principal (200 + empty list) — cached until the
 * next tick and re-shown as a delayed list on every reload.
 */
export function useImportJobs(pollMs = 3000, enabled = true) {
  const { uid, authReady } = useAuthPrincipal()
  return useQuery({
    queryKey: ['import-jobs', uid],
    queryFn: fetchImportJobs,
    refetchInterval: enabled && authReady ? pollMs : false,
    refetchOnWindowFocus: true,
    enabled: enabled && authReady,
  })
}
