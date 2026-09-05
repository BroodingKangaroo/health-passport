'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { Bell, BellOff, Check, CheckCheck, FileCheck2, TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  dismissNotification,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '@/services/notifications'
import { retryImportJob } from '@/services/import-jobs'

/**
 * Pure decision behind the coalesced toasts: the unread import
 * notifications that arrived strictly after `prevSeen` (null = first load —
 * never toast the backlog). >1 result must produce ONE summary toast.
 */
export function freshImportNotifications(
  items: NotificationItem[],
  prevSeen: string | null,
): NotificationItem[] {
  return items.filter(
    (n) => !n.read_at && n.created_at !== null && (!prevSeen || n.created_at > prevSeen),
  )
}

/**
 * Notification bell (top-right, visible for anonymous sessions too).
 *
 * Badge = unread count. Toasts are COALESCED: >1 newly-arrived unread
 * import notifications produce ONE summary toast linking to /imports; a
 * single new one toasts individually with a review deep-link — no toast
 * storms when a background tab (iOS Safari suspends JS) catches up on
 * resume. Polls ~10s + refetch on window focus; opening the dropdown marks
 * everything read (the badge clears) — toasts key off created_at, not the
 * read state, so arrival detection is independent of opening the bell.
 */
export function NotificationBell() {
  const t = useTranslations('import')
  const router = useRouter()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // Newest seen notification created_at (null = nothing seen yet — the
  // first load must never toast the backlog). `loadedRef` separates "never
  // seen anything" from "seen an empty list".
  const seenRef = useRef<string | null>(null)
  const loadedRef = useRef(false)

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: fetchNotifications,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  })

  const unreadCount = data?.unread_count ?? 0
  const items = data?.items ?? []

  // Coalesced arrival toasts.
  useEffect(() => {
    if (!data) return
    const newest = data.items[0]?.created_at ?? null
    const prevSeen = seenRef.current
    seenRef.current = newest
    if (!loadedRef.current) {
      loadedRef.current = true
      return
    }
    const fresh = freshImportNotifications(data.items, prevSeen)
    if (fresh.length === 0) return
    if (fresh.length === 1) {
      const n = fresh[0]
      const filename = n.payload?.filename ?? ''
      if (n.type === 'import_job_done') {
        toast.success(t('bellToastSingle', { filename }), {
          action: {
            label: t('bellDoneAction'),
            onClick: () => n.job_id && router.push(`/review-import?job=${n.job_id}`),
          },
        })
      } else {
        toast.error(t('bellFailedTitle'), {
          description: filename,
          action: {
            label: t('bellFailedAction'),
            onClick: () => n.job_id && router.push('/imports'),
          },
        })
      }
    } else {
      toast.success(t('bellToastMany', { count: fresh.length }), {
        action: { label: t('bellViewAll'), onClick: () => router.push('/imports') },
      })
    }
  }, [data, t, router])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && unreadCount > 0) {
      // Badge clears on open; toasts keep keying off created_at.
      void markAllNotificationsRead()
        .then(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }))
        .catch(() => {})
    }
  }

  async function handleMarkAllRead() {
    try {
      await markAllNotificationsRead()
      await queryClient.invalidateQueries({ queryKey: ['notifications'] })
    } catch {
      /* badge stays until the next poll */
    }
  }

  async function handleRetry(item: NotificationItem) {
    if (!item.job_id) return
    try {
      await retryImportJob(item.job_id)
      await queryClient.invalidateQueries({ queryKey: ['import-jobs'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('bellFailedTitle'))
    }
  }

  async function handleDismiss(item: NotificationItem) {
    try {
      await dismissNotification(item.id)
      await queryClient.invalidateQueries({ queryKey: ['notifications'] })
    } catch {
      /* stays until the next poll */
    }
  }

  async function handleItemClick(item: NotificationItem) {
    if (!item.read_at) {
      void markNotificationRead(item.id)
        .then(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }))
        .catch(() => {})
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={toggle}
        aria-label={t('bellLabel')}
        data-testid="notification-bell"
      >
        <Bell className="size-3.5" />
        {unreadCount > 0 && (
          <span
            className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold leading-none text-primary-foreground"
            data-testid="bell-badge"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1.5 w-80 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
          data-testid="bell-dropdown"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-semibold text-foreground">{t('bellLabel')}</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <CheckCheck className="size-3" />
                {t('bellMarkAllRead')}
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
              <BellOff className="size-3.5" />
              {t('bellEmpty')}
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {items.map((item) => (
                <li
                  key={item.id}
                  onClick={() => void handleItemClick(item)}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0',
                    !item.read_at && 'bg-primary/5',
                  )}
                >
                  {item.type === 'import_job_done' ? (
                    <FileCheck2 className="mt-0.5 size-4 shrink-0 text-primary" />
                  ) : (
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-high" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">
                      {item.type === 'import_job_done'
                        ? t('bellDoneTitle')
                        : t('bellFailedTitle')}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {item.payload?.filename}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      {item.type === 'import_job_done' && item.job_id && (
                        <Link
                          href={`/review-import?job=${item.job_id}`}
                          onClick={() => setOpen(false)}
                          className="text-[11px] font-semibold text-primary underline underline-offset-2"
                        >
                          {t('bellDoneAction')}
                        </Link>
                      )}
                      {item.type === 'import_job_failed' && item.job_id && (
                        <button
                          type="button"
                          onClick={() => void handleRetry(item)}
                          className="text-[11px] font-semibold text-primary underline underline-offset-2"
                        >
                          {t('bellFailedAction')}
                        </button>
                      )}
                      {!item.read_at && (
                        <button
                          type="button"
                          onClick={() => void handleItemClick(item)}
                          aria-label={t('bellMarkAllRead')}
                          className="flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          <Check className="size-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDismiss(item)}
                        className="ml-auto flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3" />
                        {t('bellDismiss')}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-border p-1">
            <Link
              href="/imports"
              onClick={() => setOpen(false)}
              className="block rounded-md px-2.5 py-2 text-xs font-medium text-primary hover:bg-accent"
            >
              {t('bellViewAll')}
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
