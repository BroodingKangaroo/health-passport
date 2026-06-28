'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchTimelineEvents } from '@/services/api'
import type { TimelineResponse } from '@/lib/types'

interface UseTimelineDataReturn {
  data: TimelineResponse | null
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export function useTimelineData(): UseTimelineDataReturn {
  const [data, setData] = useState<TimelineResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    fetchTimelineEvents()
      .then(setData)
      .catch(setError)
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  return { data, isLoading, error, refetch: load }
}
