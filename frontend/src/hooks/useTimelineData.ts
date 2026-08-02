'use client'

import { useQuery } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import { fetchTimelineEvents } from '@/services/api'

export function useTimelineData() {
  const { data: session, status } = useSession()
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['timeline', session?.user?.id ?? 'anon'],
    queryFn: fetchTimelineEvents,
    staleTime: 1000 * 60 * 5,
    enabled: status !== 'loading',
  })

  return { data, isLoading: isLoading || status === 'loading', error, refetch }
}