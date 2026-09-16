'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Copy, Link2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useAuthPrincipal } from '@/lib/hooks/useAuthPrincipal'
import { createShareLink, fetchFlowsheetData, translateBiomarkerNames } from '@/services/api'
import { shareUrl } from '@/lib/share'
import type { ShareLinkCreated } from '@/lib/share'
import { cn, formatDate } from '@/lib/utils'

/**
 * Registered senders choose 1, 7 or 30 days; anonymous senders 1 or 7 only.
 * The cap is enforced server-side as well (S4) — the dialog must never offer
 * an option the request would come back refused for.
 */
const REGISTERED_EXPIRY_DAYS = [1, 7, 30] as const
const ANONYMOUS_EXPIRY_DAYS = [1, 7] as const
const DEFAULT_EXPIRY_DAYS = 7

/**
 * The sender's entry point, sitting next to Print/export — the same "give this
 * to my doctor" intent, as the lighter sibling of the printed document.
 *
 * Stage 2 makes the link configurable (scope, expiry, header) at creation
 * time; managing and revoking what is already out there lives in the
 * "Shared links" card on /settings, next to this feature's own history. The
 * link is offered as copy-to-clipboard: the app is not the courier, and the
 * sender is the one who decides who receives clinical data.
 */
export function ShareLinkButton() {
  const t = useTranslations('share')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Link2 className="size-3.5" />
        {t('button')}
      </Button>
      <ShareLinkDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

function ShareLinkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('share')
  const locale = useLocale()
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const { uid, authReady } = useAuthPrincipal()

  // While the session is still resolving we cannot tell a registered sender
  // from an anonymous one, so the dialog offers only the intersection (1/7):
  // that can never imply an expiry the server would refuse.
  const isAnonymous = authReady && uid === 'anon'
  const expiryOptions = isAnonymous || !authReady ? ANONYMOUS_EXPIRY_DAYS : REGISTERED_EXPIRY_DAYS

  const [scopeKind, setScopeKind] = useState<'all' | 'range'>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [expiryDays, setExpiryDays] = useState<number>(DEFAULT_EXPIRY_DAYS)
  const [includeHeader, setIncludeHeader] = useState(true)
  // "auto" = no preset: the recipient's browser decides (S10). The link can
  // also be pinned to English or Russian, and the recipient can always switch
  // on the page itself.
  const [defaultLocale, setDefaultLocale] = useState<'auto' | 'en' | 'ru'>('auto')
  // The translate-now payload: only the biomarkers actually present in the
  // record, missing names.ru. Fetched once per dialog open for a registered
  // sender; scoped to the flowsheet's matrix rows (the same source the print
  // flow feeds the translate endpoint with) so a 1500-row LOINC dictionary
  // never becomes a 1500-name LLM batch (stage-3 review, F2).
  const [missingRuNames, setMissingRuNames] = useState<{ id: string; name: string }[] | null>(null)
  const [translateRequested, setTranslateRequested] = useState(false)
  const [translateState, setTranslateState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle')

  const [created, setCreated] = useState<ShareLinkCreated | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  // A fresh dialog starts from a clean slate: the raw token is shown exactly
  // once, so reopening must not replay the previous one as if it were still
  // retrievable. Adjusted during render (never a setState in an effect).
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setCreated(null)
      setCopied(false)
      setFailed(false)
      setDefaultLocale('auto')
      setTranslateRequested(false)
      setTranslateState('idle')
      setMissingRuNames(null)
    }
  }

  // Fetching the definition set is the owner's half of the feature, so it is
  // gated on the session state AND only ever happens while the dialog is open.
  useEffect(() => {
    if (!open || !authReady || isAnonymous) return
    let cancelled = false
    fetchFlowsheetData()
      .then((flowsheet) => {
        if (cancelled) return
        const defByRowId = new Map<string, { names?: Record<string, string> }>()
        for (const result of flowsheet.biomarkers) {
          defByRowId.set(result.definition.id, result.definition)
        }
        const missing: { id: string; name: string }[] = []
        const seen = new Set<string>()
        for (const category of flowsheet.matrix) {
          for (const row of category.rows) {
            if (seen.has(row.id)) continue
            seen.add(row.id)
            const definition = defByRowId.get(row.id)
            if ((definition?.names ?? {})['ru']) continue
            const name = (definition?.names?.en ?? row.name).trim()
            // Never ask the LLM to invent an English name for a nameless row.
            if (!name) continue
            missing.push({ id: row.id, name })
          }
        }
        setMissingRuNames(missing)
      })
      .catch(() => {
        // A failed read just hides the translate step; the link itself never
        // depends on it.
        if (!cancelled) setMissingRuNames([])
      })
    return () => {
      cancelled = true
    }
  }, [open, authReady, isAnonymous])

  const canTranslateNow =
    !isAnonymous &&
    authReady &&
    defaultLocale === 'ru' &&
    (missingRuNames?.length ?? 0) > 0

  // Both dates are `YYYY-MM-DD`, so a plain string compare is chronological.
  const rangeInvalid = scopeKind === 'range' && !!from && !!to && from > to

  async function create(e: FormEvent) {
    e.preventDefault()
    if (rangeInvalid) return
    setBusy(true)
    setCopied(false)
    try {
      const link = await createShareLink({
        expiry_days: expiryDays,
        scope: scopeKind === 'range' ? { kind: 'range', from: from || null, to: to || null } : null,
        include_header: includeHeader,
        default_locale: defaultLocale === 'auto' ? null : defaultLocale,
      })
      setCreated(link)
      setFailed(false)
      if (translateRequested && canTranslateNow && missingRuNames) {
        setTranslateState('working')
        try {
          await translateBiomarkerNames('ru', missingRuNames, { persist: true })
          setTranslateState('done')
        } catch {
          // The link is already made and the copy said the run could fail:
          // the recipient falls back to the English names.
          setTranslateState('failed')
        }
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const url = created ? shareUrl(window.location.origin, created.token) : ''

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="share-dialog-title"
      panelClassName="max-w-md"
    >
      <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg">
        <div>
          <h2 id="share-dialog-title" className="text-base font-semibold text-foreground">
            {t('dialog.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('dialog.body')}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t('dialog.warning')}</p>
        </div>

        {created ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
            <code className="break-all text-xs text-foreground">{url}</code>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void copy(url)}>
                <Copy className="size-3.5" />
                {copied ? t('dialog.copied') : t('dialog.copy')}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('dialog.expires', {
                  date: formatDate(created.expires_at, dateLocale),
                })}
              </span>
            </div>
            {translateState === 'working' && (
              <p className="text-xs text-muted-foreground" role="status">
                {t('dialog.translating')}
              </p>
            )}
            {translateState === 'done' && (
              <p className="text-xs text-foreground" role="status">
                {t('dialog.translated')}
              </p>
            )}
            {translateState === 'failed' && (
              <p className="text-xs text-amber-600" role="status">
                {t('dialog.translateFailed')}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={create} className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-foreground">
                {t('dialog.scope')}
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                <label className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                  <input
                    type="radio"
                    name="share-scope"
                    checked={scopeKind === 'all'}
                    onChange={() => setScopeKind('all')}
                    className="size-3.5 accent-primary"
                  />
                  {t('dialog.scopeAll')}
                </label>
                <label className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                  <input
                    type="radio"
                    name="share-scope"
                    checked={scopeKind === 'range'}
                    onChange={() => setScopeKind('range')}
                    className="size-3.5 accent-primary"
                  />
                  {t('dialog.scopeRange')}
                </label>
              </div>
              {scopeKind === 'range' && (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t('dialog.from')}
                    <Input
                      type="date"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                      data-testid="share-scope-from"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t('dialog.to')}
                    <Input
                      type="date"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      data-testid="share-scope-to"
                    />
                  </label>
                </div>
              )}
              {rangeInvalid && <p className="text-xs text-destructive">{t('dialog.rangeInvalid')}</p>}
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-foreground">
                {t('dialog.language')}
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {(
                  [
                    ['auto', t('dialog.languageAuto')],
                    ['en', t('dialog.languageEn')],
                    ['ru', t('dialog.languageRu')],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
                    <input
                      type="radio"
                      name="share-locale"
                      checked={defaultLocale === value}
                      onChange={() => setDefaultLocale(value)}
                      className="size-3.5 accent-primary"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t('dialog.languageHint')}</p>
            </fieldset>

            {canTranslateNow && (
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={translateRequested}
                  onChange={(e) => setTranslateRequested(e.target.checked)}
                  className="mt-0.5 size-4 accent-primary"
                  data-testid="share-translate-now"
                />
                <span>
                  <span className="block text-sm text-foreground">{t('dialog.translateNow')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('dialog.translateNowHint')}
                  </span>
                </span>
              </label>
            )}

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-foreground">
                {t('dialog.expiry')}
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {expiryOptions.map((days) => (
                  <label
                    key={days}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm transition-colors',
                      expiryDays === days
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    <input
                      type="radio"
                      name="share-expiry"
                      checked={expiryDays === days}
                      onChange={() => setExpiryDays(days)}
                      className="size-3.5 accent-primary"
                    />
                    {t('dialog.days', { count: days })}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={includeHeader}
                onChange={(e) => setIncludeHeader(e.target.checked)}
                className="mt-0.5 size-4 accent-primary"
                data-testid="share-include-header"
              />
              <span>
                <span className="block text-sm text-foreground">{t('dialog.includeHeader')}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('dialog.includeHeaderHint')}
                </span>
              </span>
            </label>

            {isAnonymous && (
              <p className="text-xs text-amber-600">{t('dialog.anonymousWarning')}</p>
            )}

            <div>
              <Button type="submit" size="sm" disabled={busy || rangeInvalid}>
                {busy ? t('dialog.creating') : t('dialog.create')}
              </Button>
            </div>
          </form>
        )}

        {failed && (
          <p className="text-sm text-destructive" role="alert">
            {t('dialog.error')}
          </p>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('dialog.close')}
          </Button>
        </div>
      </div>
    </ModalDialog>
  )
}
