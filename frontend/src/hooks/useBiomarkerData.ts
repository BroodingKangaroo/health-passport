'use client'

import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import { fetchBiomarkerDetail } from '@/services/api'
import type { BiomarkerResult } from '@/lib/types'

interface UseBiomarkerDataReturn {
  data: BiomarkerResult | null
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export function useBiomarkerData(id: string | null): UseBiomarkerDataReturn {
  // Session-readiness gate (see useAuthPrincipal): a fetch fired while
  // next-auth is still resolving carries no bearer token and is answered by
  // the ANONYMOUS principal — a logged-in hard reload of /details would then
  // 404 (notFound()) on the user's own biomarker and cache the miss.
  const { data: session, status } = useSession()
  const uid = session?.user?.id ?? 'anon'
  const query = useQuery({
    queryKey: ['biomarker', uid, id ?? 'none'],
    queryFn: () => fetchBiomarkerDetail(id as string),
    enabled: status !== 'loading' && !!id,
    staleTime: 1000 * 60 * 5,
  })

  const onRefetch = useCallback(() => {
    void query.refetch()
  }, [query])

  return {
    data: query.data ?? null,
    // Without an id (or before the session resolves) there is nothing to
    // load — treat as loading (matches the pre-query behavior) so the caller
    // keeps rendering its loading state instead of calling notFound().
    isLoading: query.isLoading || status === 'loading' || !id,
    error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
    refetch: onRefetch,
  }
}