'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'

interface LeaveGuardContextValue {
  /** True while an AI process (extraction / translation) is guarded. */
  busy: boolean
  /**
   * Start guarding: blocks browser Back/Forward and reload/close.
   * `onLeave` runs the moment a confirmed leave happens — callers should
   * abort their in-flight request so its completion cannot outlive the page.
   */
  arm: (message: string, onLeave?: () => void) => void
  /**
   * Stop guarding and (by default) drop the internal history marker. Pass
   * `{ pop: false }` when a programmatic navigation follows immediately —
   * the marker pop would race it. Leftover markers are absorbed silently.
   */
  disarm: (opts?: { pop?: boolean }) => void
  /** Ask to leave while a process is running. Resolves true when confirmed. */
  confirmLeave: () => Promise<boolean>
}

const LeaveGuardContext = createContext<LeaveGuardContextValue | null>(null)

export function useLeaveGuard() {
  const ctx = useContext(LeaveGuardContext)
  if (!ctx) throw new Error('useLeaveGuard must be used within a LeaveGuardProvider')
  return ctx
}

// Marker entry pushed on top of the real page while a process is guarded. The
// browser Back button then pops the marker (invisible — same URL) instead of
// leaving the page, giving us a chance to ask first.
const MARKER = { leaveGuard: true } as const

function isMarkerState(state: unknown): boolean {
  return !!(state && (state as { leaveGuard?: boolean }).leaveGuard)
}

interface ConfirmState {
  message: string
}

export function LeaveGuardProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('misc.leaveGuard')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  // Refs mirror the state so event handlers attached outside render always
  // read the current values.
  const busyRef = useRef(false)
  const messageRef = useRef('')
  const onLeaveRef = useRef<(() => void) | null>(null)
  const dialogOpenRef = useRef(false)
  const pendingResolversRef = useRef<Array<(ok: boolean) => void>>([])

  const resolveConfirm = useCallback((ok: boolean) => {
    dialogOpenRef.current = false
    setConfirm(null)
    const resolvers = pendingResolversRef.current.splice(0)
    for (const r of resolvers) r(ok)
  }, [])

  // Mark the guard disarmed and fire the process's leave callback. Used by
  // every confirmed-leave path so the in-flight request is aborted
  // immediately — even before the page unmounts — so a stale completion can
  // never hijack navigation.
  const applyLeave = useCallback(() => {
    busyRef.current = false
    setBusy(false)
    const onLeave = onLeaveRef.current
    onLeaveRef.current = null
    onLeave?.()
  }, [])

  const confirmLeave = useCallback(() => {
    return new Promise<boolean>((resolve) => {
      pendingResolversRef.current.push(resolve)
      if (dialogOpenRef.current) return
      dialogOpenRef.current = true
      // The dialog shows the armed process's message — the guard is only
      // armed while a process is running, so the message is always set here.
      setConfirm({ message: messageRef.current })
    })
  }, [])

  // Browser Back/Forward while guarded: the pop lands on our marker entry
  // (same URL, so nothing visibly happens). Absorb it by pushing a fresh
  // marker so the next Back is blocked the same way, then ask. On
  // confirmation, honor the absorbed Back by going back two entries
  // (marker -> current page -> previous page).
  //
  // While NOT guarded, a marker left behind by disarm({ pop: false }) (see
  // below) is consumed silently: one invisible hop per Back press until the
  // stack is clean. This keeps programmatic exits race-free without ever
  // presenting the user with a "dead" Back press.
  const handlePop = useCallback(() => {
    if (!busyRef.current) {
      if (isMarkerState(history.state)) history.go(-1)
      return
    }
    history.pushState(MARKER, '')
    if (dialogOpenRef.current) return
    void confirmLeave().then((ok) => {
      if (!ok) return
      applyLeave()
      history.go(-2)
    })
  }, [confirmLeave, applyLeave])

  // Native prompt for reload / close / hard navigation (soft in-app
  // navigations and the browser Back button go through the styled dialog).
  useEffect(() => {
    if (!busy) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = messageRef.current
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [busy])

  // Always-on: besides intercepting Back while guarded, this also consumes
  // stale markers left behind by disarm({ pop: false }) once the guard is
  // disarmed. Both branches read refs, so attaching permanently is safe.
  useEffect(() => {
    window.addEventListener('popstate', handlePop)
    return () => window.removeEventListener('popstate', handlePop)
  }, [handlePop])

  const arm = useCallback((msg: string, onLeave?: () => void) => {
    if (busyRef.current) return
    busyRef.current = true
    messageRef.current = msg
    onLeaveRef.current = onLeave ?? null
    setBusy(true)
    // Push the marker ON TOP of the current page so the next Back press pops
    // it (invisible, same URL) instead of leaving the page. If the top entry
    // is already a marker (left by a disarm({ pop: false }) programmatic exit
    // on this page), don't stack another one — one is enough to intercept Back.
    if (!isMarkerState(history.state)) {
      history.pushState(MARKER, '')
    }
  }, [])

  /** Stop guarding. By default pops the marker entry (`history.go(-1)`); pass
   * `{ pop: false }` when the caller navigates programmatically right after:
   * `go(-1)` delivers its popstate ASYNC — into the middle of the in-flight
   * Next.js soft navigation, which then aborts the pending push as stale.
   * Leaving the marker instead is safe: handlePop consumes it silently while
   * the guard is disarmed. */
  const disarm = useCallback(
    (opts?: { pop?: boolean }) => {
      if (!busyRef.current) return
      busyRef.current = false
      onLeaveRef.current = null
      // A dialog left open by a finished process: close it as "stay".
      resolveConfirm(false)
      setBusy(false)
      // Pop the marker entry. Its URL equals the current page's, so the pop is
      // invisible. Guarded by the state flag so we never pop a real entry
      // (e.g. when the confirmed-leave path already consumed the marker).
      if ((opts?.pop ?? true) && isMarkerState(history.state)) {
        history.go(-1)
      }
    },
    [resolveConfirm],
  )

  const confirmAndLeave = useCallback(async () => {
    // Not guarded (no process running): navigate freely without asking.
    if (!busyRef.current) return true
    const ok = await confirmLeave()
    if (!ok) return false
    applyLeave()
    return true
  }, [confirmLeave, applyLeave])

  return (
    <LeaveGuardContext.Provider value={{ busy, arm, disarm, confirmLeave: confirmAndLeave }}>
      {children}
      {confirm && (
        <div
          role="alertdialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            // A click on the dimmed backdrop counts as "Stay". Panel clicks
            // bubble up here too, so only react when the backdrop itself
            // was the target.
            if (e.target === e.currentTarget) resolveConfirm(false)
          }}
        >
          <div className="mx-4 w-full max-w-md rounded-xl bg-background p-6 shadow-xl">
            <div className="mb-4 flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {t('title')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{confirm.message}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => resolveConfirm(false)}>
                {t('stay')}
              </Button>
              <Button variant="destructive" onClick={() => resolveConfirm(true)}>
                {t('leave')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </LeaveGuardContext.Provider>
  )
}
