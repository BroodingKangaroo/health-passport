'use client'

import { useQuery } from '@tanstack/react-query'

import { fetchImportJobs } from '@/services/import-jobs'

/**
 * Shared import-jobs poll: ONE react-query cache key (`['import-jobs']`) so
 * the batch panel on /add-entry and the /imports tracker stay in sync —
 * a refetch from either page updates both. Polls ~3s while mounted and
 * refetches on window focus (iOS Safari suspends JS in background tabs;
 * all catch-ups must surface on resume).
 */
export function useImportJobs(pollMs = 3000, enabled = true) {
  return useQuery({
    queryKey: ['import-jobs'],
    queryFn: fetchImportJobs,
    refetchInterval: enabled ? pollMs : false,
    refetchOnWindowFocus: true,
  })
}
