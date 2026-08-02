'use client'

import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchBiomarkerDetail } from '@/services/api'
import type { BiomarkerResult } from '@/lib/types'

interface UseBiomarkerDataReturn {
  data: BiomarkerResult | null
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export function useBiomarkerData(id: string | null): UseBiomarkerDataReturn {
  const query = useQuery({
    queryKey: ['biomarker', id ?? 'none'],
    queryFn: () => fetchBiomarkerDetail(id as string),
    enabled: !!id,
    staleTime: 1000 * 60 * 5,
  })

  const onRefetch = useCallback(() => {
    void query.refetch()
  }, [query])

  return {
    data: query.data ?? null,
    // Without an id there is nothing to load — treat as loading (matches the
    // pre-query behavior) so the caller keeps rendering its loading state.
    isLoading: query.isLoading || !id,
    error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
    refetch: onRefetch,
  }
}