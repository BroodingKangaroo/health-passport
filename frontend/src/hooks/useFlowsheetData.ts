'use client'

import { useQuery } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import { fetchFlowsheetData } from '@/services/api'
import type { FlowsheetResponse } from '@/lib/types'

export function useFlowsheetData() {
  const { data: session, status } = useSession()
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['flowsheet', session?.user?.id ?? 'anon'],
    queryFn: fetchFlowsheetData,
    staleTime: 1000 * 60 * 5,
    enabled: status !== 'loading',
  })

  return { data, isLoading: isLoading || status === 'loading', error, refetch }
}