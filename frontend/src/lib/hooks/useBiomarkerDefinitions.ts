'use client'

import { useQuery } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import { fetchBiomarkerDefinitions } from '@/services/api'

export function useBiomarkerDefinitions() {
  const { data: session, status } = useSession()
  const { data: definitions = [], isLoading: loading, error } = useQuery({
    queryKey: ['biomarker-definitions', session?.user?.id ?? 'anon'],
    queryFn: fetchBiomarkerDefinitions,
    staleTime: 1000 * 60 * 30,
    enabled: status !== 'loading',
  })

  return { definitions, loading: loading || status === 'loading', error: error instanceof Error ? error.message : null }
}
