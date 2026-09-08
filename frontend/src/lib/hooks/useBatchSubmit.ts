'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { createImportJob } from '@/services/import-jobs'
import { fetchUsageLimits } from '@/services/api'

export type BatchSubmitError =
  | { kind: 'limits' }
  | { kind: 'submit'; message: string }

export interface BatchSubmitOutcome {
  submittedIds: string[]
  /** Files beyond the remaining quota — never submitted. */
  skippedCount: number
  /** Non-null when the quota check failed or a submission errored mid-loop. */
  error: BatchSubmitError | null
  /** True when the component unmounted mid-loop (the caller must not
   * navigate — the user left deliberately; accepted jobs continue anyway). */
  cancelled: boolean
}

/**
 * Headless batch submission for /add-entry (ISSUES.md #76 rework — the
 * interactive BatchImportPanel is gone; /imports is the single cockpit):
 * capped, SEQUENTIAL POSTs — `min(N, remaining)` from the usage limits, a
 * failed submit stops the loop (never fire-all-and-eat-429s), a failed
 * limits check fails closed — plus a plain `beforeunload` prompt while
 * submissions are in flight. Jobs already accepted are safe: extraction
 * continues server-side and is tracked on /imports.
 */
export function useBatchSubmit() {
  const [submitting, setSubmitting] = useState(false)
  const [total, setTotal] = useState(0)
  const submittingRef = useRef(false)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!submitting) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [submitting])

  const submit = useCallback(async (files: File[]): Promise<BatchSubmitOutcome> => {
    const outcome: BatchSubmitOutcome = {
      submittedIds: [],
      skippedCount: 0,
      error: null,
      cancelled: false,
    }
    if (files.length === 0 || submittingRef.current) return outcome
    submittingRef.current = true
    setSubmitting(true)
    setTotal(files.length)
    try {
      let cap = 0
      try {
        const limits = await fetchUsageLimits()
        const remaining = Math.max(0, limits.ai_extraction_limit - limits.ai_extraction_count)
        cap = Math.min(files.length, remaining)
      } catch {
        // Fail closed — without limits the batch cannot be capped.
        outcome.error = { kind: 'limits' }
        return outcome
      }
      outcome.skippedCount = files.length - cap
      for (let i = 0; i < cap; i++) {
        if (cancelledRef.current) {
          outcome.cancelled = true
          break
        }
        try {
          outcome.submittedIds.push(await createImportJob(files[i]))
        } catch (err) {
          outcome.error = {
            kind: 'submit',
            message: err instanceof Error ? err.message : '',
          }
          break
        }
      }
      if (cancelledRef.current) outcome.cancelled = true
      return outcome
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [])

  return { submitting, total, submit }
}
