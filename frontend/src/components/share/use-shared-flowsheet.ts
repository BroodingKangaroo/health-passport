'use client'

import { useCallback, useEffect, useState } from 'react'

import { readShareGrant } from '@/lib/share-grant'
import { fetchSharedFlowsheet } from '@/services/share'
import type { SharedFlowsheet } from '@/lib/share'

export type SharedFlowsheetStatus = 'loading' | 'ready' | 'error'

export interface SharedFlowsheetState {
  flowsheet: SharedFlowsheet | null
  status: SharedFlowsheetStatus
  retry: () => void
}

/**
 * The full longitudinal table's payload, fetched ONCE per page.
 *
 * This lives in the shell (`SharedRecordView`) rather than inside the table
 * component because the table is rendered by BOTH views: with the fetch owned
 * by the view, every Summary ↔ Full record switch tore the component down and
 * re-requested it — 1 request on load plus 1 per toggle, and the payload is
 * ~1.3 MB from the backend. Hoisting it here is what makes the plan's
 * "switching is instant … no refetch" true.
 *
 * Lazy on purpose: the record renders first, the table follows, so the table
 * never weighs down the first paint. `no-store` for the same reason the record
 * read is (revocation must take effect on the next request), and the unlock
 * grant travels with it because a protected link reaches this point already
 * unlocked — a missing grant would 404 here while the record above rendered
 * fine (Stage 4, S15).
 */
export function useSharedFlowsheet(token: string): SharedFlowsheetState {
  const [flowsheet, setFlowsheet] = useState<SharedFlowsheet | null>(null)
  const [status, setStatus] = useState<SharedFlowsheetStatus>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const payload = (await fetchSharedFlowsheet(
          token,
          readShareGrant(token),
        )) as SharedFlowsheet
        if (!cancelled) {
          setFlowsheet(payload)
          setStatus('ready')
        }
      } catch {
        if (!cancelled) setStatus('error')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [token, attempt])

  const retry = useCallback(() => {
    setStatus('loading')
    setAttempt((n) => n + 1)
  }, [])

  return { flowsheet, status, retry }
}
