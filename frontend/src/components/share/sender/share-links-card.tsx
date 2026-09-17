'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Link2, Lock, Sparkles } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAuthPrincipal } from '@/lib/hooks/useAuthPrincipal'
import { listShareLinks, revokeAllShareLinks, revokeShareLink } from '@/services/api'
import type {
  ShareEntryType,
  ShareLinkScope,
  ShareLinkState,
  ShareLinkSummary,
} from '@/lib/share'
import { formatDate } from '@/lib/utils'

type BadgeVariant = 'normal' | 'outline' | 'chip'

/** The card's word for each excludable entry type, matching the dialog's. */
const EXCLUDE_LABEL_KEY: Record<ShareEntryType, string> = {
  blood_test: 'excludeBloodTest',
  doctor_visit: 'excludeDoctorVisit',
  instrumental_test: 'excludeInstrumentalTest',
  procedure: 'excludeProcedure',
}

/** Link liveness is its own scale — none of these are health statuses. */
const STATE_BADGE: Record<ShareLinkState, { variant: BadgeVariant; className?: string }> = {
  active: { variant: 'normal' },
  expired: { variant: 'outline', className: 'text-muted-foreground' },
  revoked: { variant: 'chip' },
}

/**
 * A scope's dates are whole days (`2026-01-31`), so they are parsed as LOCAL
 * midnight: `new Date('2026-01-31')` is UTC midnight, which a browser east of
 * Greenwich renders as the previous day — or, via `formatDate`, as an
 * "at 03:00" stamp on a date the sender never chose.
 */
function scopeDay(value: string, dateLocale: string): string {
  return formatDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value, dateLocale)
}

function scopeText(
  scope: ShareLinkScope,
  t: (key: string, values?: Record<string, string>) => string,
  dateLocale: string,
): string {
  if (scope.kind !== 'range' || (!scope.from && !scope.to)) return t('scopeAll')
  if (scope.from && scope.to) {
    return t('scopeRange', {
      from: scopeDay(scope.from, dateLocale),
      to: scopeDay(scope.to, dateLocale),
    })
  }
  return scope.from
    ? t('scopeFrom', { from: scopeDay(scope.from, dateLocale) })
    : t('scopeUntil', { to: scopeDay(scope.to as string, dateLocale) })
}

/**
 * What the link withholds, in the sender's own words (Stage 4, S16).
 *
 * Rendered as its own line rather than folded into the scope sentence: "Whole
 * record, without imaging" is two separate choices, and a sender scanning the
 * list needs to see at a glance which links are partial.
 */
function exclusionText(
  scope: ShareLinkScope,
  t: (key: string, values?: Record<string, string>) => string,
): string | null {
  const excluded = scope.exclude ?? []
  if (excluded.length === 0) return null
  return t('scopeExclude', {
    types: excluded.map((entryType) => t(EXCLUDE_LABEL_KEY[entryType])).join(', '),
  })
}

/**
 * Every link the sender ever created, newest first (server order). The state
 * is the SERVER's computed value — including for the confusing case of a row
 * whose date has already passed but which the backend still calls active — so
 * the client never has to reproduce the expiry policy.
 */
export function ShareLinksCard() {
  const t = useTranslations('share.card')
  const tc = useTranslations('common')
  const locale = useLocale()
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const { uid, authReady } = useAuthPrincipal()

  const [links, setLinks] = useState<ShareLinkSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await listShareLinks()
      setLinks(res.links)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    // Gate on session readiness: a tokenless fetch on a hard reload is
    // answered by the anonymous principal, which would show a registered
    // sender someone else's (empty) history and never correct itself.
    if (!authReady) return
    let cancelled = false
    listShareLinks()
      .then((res) => {
        if (cancelled) return
        setLinks(res.links)
        setFailed(false)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [authReady, uid])

  async function revoke(id: string) {
    // One in-flight revoke per row: a second call would 404 and read as a
    // failure for an action that already succeeded.
    setRevoking(id)
    try {
      await revokeShareLink(id)
      toast.success(t('revoked'))
      await refresh()
    } catch (e) {
      toast.error(t('revokeFailed'), {
        description: e instanceof Error && e.message ? e.message : undefined,
      })
    } finally {
      setRevoking(null)
    }
  }

  async function revokeAll() {
    setBusy(true)
    try {
      const res = await revokeAllShareLinks()
      setConfirmOpen(false)
      toast.success(t('revokeAllDone', { count: res.revoked }))
      await refresh()
    } catch (e) {
      toast.error(t('revokeFailed'), {
        description: e instanceof Error && e.message ? e.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  const activeCount = links?.filter((link) => link.state === 'active').length ?? 0

  return (
    <Card className="p-6" data-testid="share-links-card">
      <div className="mb-4 flex items-center gap-2">
        <Link2 className="size-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {t('title')}
        </h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('description')}</p>

      {failed ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('loadError')}
        </p>
      ) : links === null ? (
        <div className="space-y-2" data-testid="share-links-loading">
          <div className="h-12 w-full animate-pulse rounded-lg bg-muted" />
          <div className="h-12 w-full animate-pulse rounded-lg bg-muted" />
        </div>
      ) : links.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="share-links-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {links.map((link) => {
            const badge = STATE_BADGE[link.state]
            const exclusions = exclusionText(link.scope, t)
            return (
              <li
                key={link.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg border border-border px-3 py-2"
                data-testid="share-link-row"
                data-state={link.state}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge variant={badge.variant} className={badge.className}>
                      {t(`state.${link.state}`)}
                    </Badge>
                    {/* A protected link is a different promise from an open
                        one, so the marker sits beside the state, not in the
                        detail line: it is what the sender scans for (S15). */}
                    {link.requires_passcode && (
                      <Badge variant="outline" data-testid="share-protected">
                        <Lock className="size-3" />
                        {t('protected')}
                      </Badge>
                    )}
                    <span className="text-sm text-foreground" data-testid="share-scope">
                      {scopeText(link.scope, t, dateLocale)}
                    </span>
                  </div>
                  {exclusions && (
                    <span className="text-xs text-muted-foreground" data-testid="share-exclusions">
                      {exclusions}
                    </span>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{t('expires', { date: formatDate(link.expires_at, dateLocale) })}</span>
                    {link.default_locale && (
                      <span data-testid="share-language">
                        {t('language', {
                          name: t(link.default_locale === 'ru' ? 'languageRu' : 'languageEn'),
                        })}
                      </span>
                    )}
                    <span>
                      {link.last_opened_at
                        ? t('opened', {
                            count: Math.max(link.open_count, 1),
                            date: formatDate(link.last_opened_at, dateLocale),
                          })
                        : t('neverOpened')}
                    </span>
                    {link.has_new_data && (
                      <span className="inline-flex items-center gap-1" data-testid="share-new-data">
                        <Sparkles className="size-3" />
                        {t('newData')}
                      </span>
                    )}
                  </div>
                </div>
                {link.state === 'active' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void revoke(link.id)}
                    disabled={revoking === link.id}
                  >
                    {t('revoke')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Only offered while something is still reachable: "Revoke all" over an
          all-expired list would be a button that does nothing. */}
      {activeCount > 0 && (
        <div className="mt-3">
          <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" disabled={busy} data-testid="share-revoke-all">
                {t('revokeAll')}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="top"
              className="w-80"
              data-testid="share-revoke-all-confirm"
            >
              <div className="space-y-3">
                <p className="text-sm font-semibold text-foreground">{t('revokeAllConfirmTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('revokeAllConfirmBody')}</p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmOpen(false)}
                    disabled={busy}
                  >
                    {tc('cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void revokeAll()}
                    disabled={busy}
                    data-testid="share-revoke-all-confirm-button"
                  >
                    {t('revokeAllConfirm')}
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </Card>
  )
}
