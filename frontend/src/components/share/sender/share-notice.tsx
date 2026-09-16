'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Info } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAuthPrincipal } from '@/lib/hooks/useAuthPrincipal'
import { ackShareNotice, fetchShareNotice } from '@/services/api'
import type { ShareNotice as ShareNoticePayload } from '@/lib/share'

/**
 * The quiet line that tells the sender their newest results have become
 * visible through a link they already handed out.
 *
 * It is deliberately not a toast and not a nag: it renders only while the
 * backend says so, the read never acknowledges anything by itself (an
 * acknowledged notice must survive a refresh), and acknowledging settles
 * every listed link at once. Nothing renders at all when the answer is "no".
 */
export function ShareNotice() {
  const t = useTranslations('share.notice')
  const { uid, authReady } = useAuthPrincipal()
  const [notice, setNotice] = useState<ShareNoticePayload | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Gate on session readiness: a tokenless read on a hard reload would be
    // answered by the anonymous principal and could show the wrong count.
    if (!authReady) return
    let cancelled = false
    fetchShareNotice()
      .then((res) => {
        if (!cancelled) setNotice(res)
      })
      .catch(() => {
        // A failed read stays silent: this line is an aside, never a blocker,
        // and a network blip must not paint an error across the timeline.
        if (!cancelled) setNotice({ active_links: 0, show: false })
      })
    return () => {
      cancelled = true
    }
  }, [authReady, uid])

  async function acknowledge() {
    setBusy(true)
    try {
      await ackShareNotice()
      // Hidden optimistically after a successful ack — the server has already
      // recorded it, so a reload keeps it hidden.
      setNotice(null)
    } catch {
      // Keep the line: an unacknowledged notice is honest, a silently
      // vanished one is not.
    } finally {
      setBusy(false)
    }
  }

  if (!notice?.show || notice.active_links <= 0) return null

  return (
    <div
      className="border-b border-border bg-muted/40 px-5 py-2 print:hidden"
      data-testid="share-notice"
    >
      <div className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <Info className="size-3.5 shrink-0" />
        <span className="text-foreground/80">
          {t('message', { count: notice.active_links })}
        </span>
        <Link href="/settings" className="text-primary hover:underline">
          {t('manage')}
        </Link>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void acknowledge()}
          disabled={busy}
          data-testid="share-notice-ack"
        >
          {t('ack')}
        </Button>
      </div>
    </div>
  )
}
