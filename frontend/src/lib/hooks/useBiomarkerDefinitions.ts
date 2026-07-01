'use client'

import { useEffect, useState } from 'react'
import { fetchBiomarkerDefinitions } from '@/services/api'
import type { BiomarkerDefinition } from '@/lib/types'

let cached: BiomarkerDefinition[] | null = null
let cachedPromise: Promise<BiomarkerDefinition[]> | null = null

export function useBiomarkerDefinitions() {
  const [definitions, setDefinitions] = useState<BiomarkerDefinition[]>(cached ?? [])
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (cached) {
      setDefinitions(cached)
      setLoading(false)
      return
    }
    if (cachedPromise) {
      cachedPromise
        .then((data) => {
          cached = data
          setDefinitions(data)
          setLoading(false)
        })
        .catch(() => {})
      return
    }
    cachedPromise = fetchBiomarkerDefinitions()
    cachedPromise
      .then((data) => {
        cached = data
        setDefinitions(data)
        setLoading(false)
      })
      .catch((err) => {
        cachedPromise = null
        setError(err instanceof Error ? err.message : 'Failed to load definitions')
        setLoading(false)
      })
  }, [])

  return { definitions, loading, error }
}
