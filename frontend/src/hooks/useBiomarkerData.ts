'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchBiomarkerDetail } from '@/services/api'
import type { BiomarkerResult } from '@/lib/types'

interface UseBiomarkerDataReturn {
  data: BiomarkerResult | null
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export function useBiomarkerData(id: string | null): UseBiomarkerDataReturn {
  const [data, setData] = useState<BiomarkerResult | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(() => {
    if (!id) { setIsLoading(false); return }
    setIsLoading(true)
    setError(null)
    fetchBiomarkerDetail(id)
      .then(setData)
      .catch(setError)
      .finally(() => setIsLoading(false))
  }, [id])

  useEffect(() => { load() }, [load])

  return { data, isLoading, error, refetch: load }
}
