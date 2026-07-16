'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
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
  const fetchIdRef = useRef(0)
  const cancelledRef = useRef(false)

  const load = useCallback(() => {
    if (!id) { setIsLoading(false); return }
    const fetchId = ++fetchIdRef.current
    cancelledRef.current = false
    setIsLoading(true)
    setError(null)
    fetchBiomarkerDetail(id)
      .then((result) => {
        if (fetchId === fetchIdRef.current && !cancelledRef.current) {
          setData(result)
        }
      })
      .catch((err) => {
        if (fetchId === fetchIdRef.current && !cancelledRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)))
        }
      })
      .finally(() => {
        if (fetchId === fetchIdRef.current && !cancelledRef.current) {
          setIsLoading(false)
        }
      })
  }, [id])

  useEffect(() => {
    load()
    return () => { cancelledRef.current = true }
  }, [load])

  return { data, isLoading, error, refetch: load }
}
