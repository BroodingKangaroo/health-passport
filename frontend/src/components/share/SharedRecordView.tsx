'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { HeartPulse, Info } from 'lucide-react'

import { FlowsheetMatrix } from '@/components/health-passport/flowsheet-matrix'
import { Button } from '@/components/ui/button'
import { formatReference } from '@/lib/reference'
import { biomarkerName, flaggedBiomarkers, SHARE_TOKEN_HEADER } from '@/lib/share'
import type { SharedFlowsheet, SharedRecord } from '@/lib/share'
import { STATUS_TEXT_CLASS, isOutOfRange } from '@/lib/status-labels'
import { cn, formatDate, formatNumber } from '@/lib/utils'
import type { BiomarkerResult } from '@/lib/types'

interface SharedRecordViewProps {
  token: string
  record: SharedRecord
  locale: string
}

/**
 * The recipient's view of a shared record.
 *
 * Order is the product decision (product plan §4.1): orientation first, then
 * what needs attention, then what changed, then the non-lab history, then the
 * full table. A doctor who reads only the flags block has already got the
 * useful part of the visit.
 *
 * The record arrives as a prop — this component performs no record fetch of
 * its own, which is what lets the sender's preview render the same view over
 * an authenticated payload later. Only the "All results" table is fetched
 * lazily, from the public flowsheet endpoint, so it never weighs down the
 * first paint.
 */
export function SharedRecordView({ token, record, locale }: SharedRecordViewProps) {
  const t = useTranslations('sharedView')
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const flags = useMemo(() => flaggedBiomarkers(record.biomarkers), [record.biomarkers])
  const trends = useMemo(
    () => flags.filter((b) => (b.history?.length ?? 0) > 0),
    [flags],
  )
  const nonLabEvents = useMemo(
    () => record.events.filter((event) => event.type !== 'blood_test').slice().reverse(),
    [record.events],
  )

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card px-5 py-5 print:border-0 print:px-0">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <HeartPulse className="size-4 text-primary" aria-hidden />
            {t('orientation.readOnly')}
          </p>
          <h1 className="text-xl font-bold text-foreground">
            {record.header?.name
              ? t('orientation.ownedBy', { name: record.header.name })
              : t('orientation.anonymous')}
          </h1>
          {record.header?.dob ? (
            <p className="text-sm text-muted-foreground">{record.header.dob}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {t('orientation.lastUpdated', {
              date: formatDate(record.meta.last_updated, dateLocale),
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('orientation.expires', {
              date: formatDate(record.meta.expires_at, dateLocale),
            })}
          </p>
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-5 py-6">
        <section aria-labelledby="shared-flags">
          <h2 id="shared-flags" className="mb-3 text-base font-semibold text-foreground">
            {t('flags.title')}
          </h2>
          {flags.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              {t('flags.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {flags.map((biomarker) => (
                <FlagCard
                  key={biomarker.id}
                  biomarker={biomarker}
                  locale={locale}
                  dateLocale={dateLocale}
                />
              ))}
            </ul>
          )}
        </section>

        {trends.length > 0 && (
          <section aria-labelledby="shared-trends">
            <h2 id="shared-trends" className="mb-3 text-base font-semibold text-foreground">
              {t('trends.title')}
            </h2>
            <ul className="flex flex-col gap-2">
              {trends.map((biomarker) => {
                const series = [...(biomarker.history ?? []).map((r) => r.value), biomarker.value]
                const since = biomarker.history?.[0]?.date ?? biomarker.date
                return (
                  <li
                    key={biomarker.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-4 py-3"
                  >
                    <span className="text-sm font-medium text-foreground">
                      {biomarkerName(biomarker.definition, locale)}
                    </span>
                    <span className="font-mono text-sm tabular-nums text-foreground">
                      {series.map((value) => formatNumber(value)).join(' → ')}
                    </span>
                    <span className="w-full text-xs text-muted-foreground">
                      {t('trends.since', { date: formatDate(since, dateLocale) })}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <section aria-labelledby="shared-history">
          <h2 id="shared-history" className="mb-3 text-base font-semibold text-foreground">
            {t('history.title')}
          </h2>
          {nonLabEvents.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              {t('history.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {nonLabEvents.map((event) => {
                const visit = record.visits[event.id]
                const instrumental = record.instrumental[event.id]
                const detail =
                  visit?.verdict?.translated_en ||
                  visit?.verdict?.original ||
                  instrumental?.conclusion ||
                  instrumental?.findings ||
                  ''
                return (
                  <li
                    key={event.id}
                    className="rounded-lg border border-border bg-card px-4 py-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-sm font-medium text-foreground">{event.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(event.date, dateLocale)}
                      </span>
                    </div>
                    {event.clinic ? (
                      <p className="text-xs text-muted-foreground">{event.clinic}</p>
                    ) : null}
                    {detail ? (
                      <p className="mt-1.5 text-sm text-foreground">{detail}</p>
                    ) : null}
                    {visit?.recommendations?.length ? (
                      <ul className="mt-1.5 list-disc pl-5 text-sm text-muted-foreground">
                        {visit.recommendations.map((rec, index) => (
                          <li key={index}>{rec.translated_en || rec.original}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <SharedResults token={token} />
      </main>

      <footer className="mx-auto max-w-3xl px-5 pb-12">
        <p className="flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('footer.disclaimer')}
        </p>
        <div className="mt-4 print:hidden">
          <Link
            href="/"
            rel="noreferrer"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('footer.cta')}
          </Link>
        </div>
      </footer>
    </div>
  )
}

function FlagCard({
  biomarker,
  locale,
  dateLocale,
}: {
  biomarker: BiomarkerResult
  locale: string
  dateLocale: string
}) {
  const t = useTranslations('sharedView')
  const unit = biomarker.definition.canonical_unit || biomarker.definition.unit
  const reference = formatReference(
    biomarker.reference ?? biomarker.definition.reference,
    unit,
    { lang: locale },
  )
  return (
    <li className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div>
          <p className="text-sm font-semibold text-foreground">
            {biomarkerName(biomarker.definition, locale)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('flags.measured', { date: formatDate(biomarker.date, dateLocale) })}
          </p>
        </div>
        <div className="text-right">
          <p
            className={cn(
              'text-lg font-bold tabular-nums',
              isOutOfRange(biomarker.status)
                ? STATUS_TEXT_CLASS[biomarker.status]
                : 'text-foreground',
            )}
          >
            {formatNumber(biomarker.value)}
            {unit ? ` ${unit}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('flags.reference')}: {reference}
          </p>
        </div>
      </div>
    </li>
  )
}

/**
 * The full longitudinal table. Fetched separately after first paint so the
 * record above it renders immediately; the token goes in the header, and the
 * request is no-store for the same reason the record read is.
 */
function SharedResults({ token }: { token: string }) {
  const t = useTranslations('sharedView')
  const [flowsheet, setFlowsheet] = useState<SharedFlowsheet | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/share/flowsheet', {
          headers: { [SHARE_TOKEN_HEADER]: token },
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        })
        if (!res.ok) throw new Error(`flowsheet responded ${res.status}`)
        const payload = (await res.json()) as SharedFlowsheet
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

  return (
    <section aria-labelledby="shared-results">
      <h2 id="shared-results" className="mb-3 text-base font-semibold text-foreground">
        {t('results.title')}
      </h2>
      {status === 'loading' && (
        <p className="text-sm text-muted-foreground">{t('results.loading')}</p>
      )}
      {status === 'error' && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">{t('results.error')}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setStatus('loading')
              setAttempt((n) => n + 1)
            }}
          >
            {t('results.retry')}
          </Button>
        </div>
      )}
      {status === 'ready' && flowsheet && flowsheet.matrix.length > 0 && (
        <FlowsheetMatrix
          dates={flowsheet.dates}
          matrix={flowsheet.matrix}
          biomarkers={flowsheet.biomarkers}
        />
      )}
    </section>
  )
}
