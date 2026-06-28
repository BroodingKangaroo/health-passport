'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchFlowsheetData } from '@/services/api'
import type { FlowsheetResponse } from '@/lib/types'

interface UseFlowsheetDataReturn {
  data: FlowsheetResponse | null
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export function useFlowsheetData(): UseFlowsheetDataReturn {
  const [data, setData] = useState<FlowsheetResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    fetchFlowsheetData()
      .then(setData)
      .catch(setError)
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  return { data, isLoading, error, refetch: load }
}
