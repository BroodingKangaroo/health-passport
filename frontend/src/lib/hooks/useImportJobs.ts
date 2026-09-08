'use client'

import { useQuery } from '@tanstack/react-query'

import { fetchImportJobs } from '@/services/import-jobs'

/**
 * Shared import-jobs poll: ONE react-query cache key (`['import-jobs']`)
 * consumed by the /imports tracker; /add-entry's post-submit invalidation
 * surfaces fresh jobs without waiting for the next tick. Polls ~3s while
 * mounted and refetches on window focus (iOS Safari suspends JS in
 * background tabs; all catch-ups must surface on resume).
 */
export function useImportJobs(pollMs = 3000, enabled = true) {
  return useQuery({
    queryKey: ['import-jobs'],
    queryFn: fetchImportJobs,
    refetchInterval: enabled ? pollMs : false,
    refetchOnWindowFocus: true,
  })
}
