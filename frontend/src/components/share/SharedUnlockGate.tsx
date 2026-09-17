'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { SharedPasscodePrompt, SharedLoadError } from '@/components/share/SharedStates'
import { SharedRecordView } from '@/components/share/SharedRecordView'
import { clearShareGrant, readShareGrant, storeShareGrant } from '@/lib/share-grant'
import type { SharedRecord } from '@/lib/share'
import {
  fetchSharedRecord,
  SharedRecordError,
  SharedUnlockFailedError,
  SharedUnlockThrottledError,
  unlockSharedRecord,
} from '@/services/share'

/**
 * There is deliberately no `unavailable` state: this component is only
 * mounted after `/api/share/status` said the link is live and protected, so a
 * later 404 means a stale GRANT, not a dead link — and the two are
 * indistinguishable by design. Asking for the code again is the honest
 * response; the dead-link page would be a claim we cannot make (Stage 4
 * review, F3).
 */
type Phase = 'prompt' | 'checking' | 'loading' | 'record' | 'error'

/**
 * The grant this tab already holds for this link, resolved ONCE during the
 * first render rather than in an effect: `sessionStorage` is a synchronous
 * store, so hiding a valid grant behind a loading flash would be a state
 * cascade for no benefit. Reading it lazily here also keeps it out of the
 * server render, where `window` does not exist.
 */
function initialGrant(token: string): string | null {
  if (typeof window === 'undefined') return null
  return readShareGrant(token)
}

/**
 * The client half of a passcode-protected link (Stage 4, S15).
 *
 * A protected link CANNOT be server-rendered: the first request carries no
 * passcode, so the server would have nothing to render. This component is what
 * happens instead — it shows the prompt, exchanges a code for a grant, stores
 * the grant in `sessionStorage` and then fetches the record.
 *
 * Unprotected links never mount this: they keep the server-rendered record
 * from Stage 1, which is faster and works without JavaScript. That is why the
 * two first-paint paths exist, and why the distinction lives here rather than
 * inside `SharedRecordView` — the view itself receives a record as a prop in
 * both cases and never knows which path produced it.
 *
 * A grant already in `sessionStorage` (the recipient reloaded, or followed a
 * link to the same record in this tab) skips the prompt entirely.
 */
export function SharedUnlockGate({
  token,
  locale,
}: {
  token: string
  locale: string
}) {
  const [phase, setPhase] = useState<Phase>('prompt')
  const [record, setRecord] = useState<SharedRecord | null>(null)
  const [failure, setFailure] = useState<'failed' | 'throttled' | null>(null)
  // The grant already in this tab, captured ONCE on first render (a lazy
  // initialiser, so nothing is written during render and nothing is re-read).
  const [initial] = useState(() => initialGrant(token))
  // Guards the initial attempt against React's development double-mount: two
  // racing reads would consume the throttle for a link that was only opened
  // once, and the second answer could overwrite the first.
  const attempted = useRef(false)

  const load = useCallback(
    async (grant: string | null) => {
      // State is touched only in the continuations below, never synchronously:
      // the initial effect calls this, and setting state in an effect body
      // schedules a second render before the first has painted.
      fetchSharedRecord(token, grant)
        .then((loaded) => {
          setRecord(loaded)
          setPhase('record')
        })
        .catch((error: unknown) => {
          if (error instanceof SharedRecordError) {
            setPhase('error')
            return
          }
          // The record read answers 404 for a dead link AND for a protected
          // link without a valid grant — they are deliberately
          // indistinguishable. On this path we know it was the grant: a stale
          // one is dropped and the recipient is asked again rather than told
          // the link is dead.
          clearShareGrant()
          setFailure('failed')
          setPhase('prompt')
        })
    },
    [token],
  )

  useEffect(() => {
    if (attempted.current) return
    attempted.current = true
    // The state change happens inside `load`'s async continuation rather than
    // synchronously here, which is what keeps this effect from cascading.
    if (initial) void load(initial)
  }, [initial, load])

  const unlock = useCallback(
    async (passcode: string) => {
      setPhase('checking')
      setFailure(null)
      try {
        const result = await unlockSharedRecord(token, passcode)
        storeShareGrant(token, result.grant, result.expiresAt)
        setPhase('loading')
        await load(result.grant)
      } catch (error) {
        if (error instanceof SharedUnlockThrottledError) {
          setFailure('throttled')
          setPhase('prompt')
        } else if (error instanceof SharedUnlockFailedError) {
          setFailure('failed')
          setPhase('prompt')
        } else {
          setPhase('error')
        }
      }
    },
    [token, load],
  )

  if (phase === 'record' && record) {
    return <SharedRecordView token={token} record={record} locale={locale} />
  }
  if (phase === 'error') return <SharedLoadError />
  if (phase === 'loading') {
    // A quiet loading state rather than the prompt: the recipient already
    // unlocked, and flashing the passcode form again would read as a failure.
    return <LoadingShell />
  }
  return (
    <SharedPasscodePrompt
      onSubmit={(passcode) => void unlock(passcode)}
      state={phase === 'checking' ? 'checking' : (failure ?? 'idle')}
    />
  )
}

function LoadingShell() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background px-5"
      data-testid="share-unlock-loading"
    >
      <div className="h-12 w-full max-w-md animate-pulse rounded-lg bg-muted" />
    </div>
  )
}
