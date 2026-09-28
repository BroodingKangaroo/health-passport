'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Minus } from 'lucide-react'

import { SharedFlowsheet } from '@/components/share/SharedFlowsheet'
import type { SharedFlowsheetState } from '@/components/share/use-shared-flowsheet'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { formatReference } from '@/lib/reference'
import {
  biomarkerName,
  flaggedBiomarkers,
  flagCounts,
  trendDirection,
  trendPoints,
} from '@/lib/share'
import type { SharedRecord } from '@/lib/share'
import { STATUS_TEXT_CLASS, isOutOfRange } from '@/lib/status-labels'
import { cn, formatDate, formatDay, formatNumberFull } from '@/lib/utils'
import type { BiomarkerResult } from '@/lib/types'

/**
 * The flags block's columns. One string, used by both the header row and every
 * reading row, so the two can never drift out of alignment. Below `md` the row
 * falls back to the card it always was.
 */
const FLAG_GRID =
  'md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.15fr)_minmax(0,1.1fr)_auto] md:gap-x-3'

/**
 * The default view: the short clinical read.
 *
 * Order is the product decision (product plan §4.1): what needs attention,
 * then what changed, then the non-lab history, then the full table. A doctor
 * who reads only the flags block has already got the useful part of the visit.
 *
 * The record arrives as a prop — this component performs no record fetch of
 * its own, which is what lets the sender's preview render the same view over
 * an authenticated payload later.
 */
export function SharedSummary({
  record,
  locale,
  dateLocale,
  flowsheetState,
}: {
  record: SharedRecord
  locale: string
  dateLocale: string
  flowsheetState: SharedFlowsheetState
}) {
  const t = useTranslations('sharedView')
  const flags = useMemo(() => flaggedBiomarkers(record.biomarkers), [record.biomarkers])
  const counts = useMemo(() => flagCounts(record.biomarkers), [record.biomarkers])
  const trends = useMemo(
    () => flags.filter((b) => (b.history?.length ?? 0) > 0),
    [flags],
  )
  const nonLabEvents = useMemo(
    () => record.events.filter((event) => event.type !== 'blood_test').slice().reverse(),
    [record.events],
  )

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="shared-flags">
        <h2 id="shared-flags" className="mb-3 scroll-mt-24 text-base font-semibold text-foreground">
          {t('flags.title')}
        </h2>
        {counts.total > 0 && (
          <p className="mb-3 text-sm text-muted-foreground" data-testid="shared-flag-count">
            {t('flags.count', { n: counts.outOfRange, m: counts.total })}
          </p>
        )}
        {flags.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            {t('flags.empty')}
          </p>
        ) : (
          <div className="md:overflow-hidden md:rounded-lg md:border md:border-border md:bg-card">
            {/* The desktop row grid's column headings. A doctor scanning a
                lab sheet expects a table; the headings are what make the
                four columns legible as one. Hidden below `md`, where each
                row is a self-describing card again. */}
            <div
              className={cn(
                'hidden md:grid md:border-b md:border-border md:bg-muted md:px-3 md:py-2',
                'md:text-[11px] md:font-semibold md:uppercase md:tracking-wide md:text-muted-foreground',
                FLAG_GRID,
              )}
            >
              <span>{t('flags.colBiomarker')}</span>
              <span className="text-right">{t('flags.colLatest')}</span>
              <span>{t('flags.reference')}</span>
              <span className="justify-self-end">{t('flags.colStatus')}</span>
            </div>
            <ul className="flex flex-col gap-3 md:gap-0">
              {flags.map((biomarker) => (
                <FlagRow
                  key={biomarker.id}
                  biomarker={biomarker}
                  locale={locale}
                  dateLocale={dateLocale}
                />
              ))}
            </ul>
          </div>
        )}
      </section>

      {trends.length > 0 && (
        <section aria-labelledby="shared-trends">
          <h2 id="shared-trends" className="mb-3 scroll-mt-24 text-base font-semibold text-foreground">
            {t('trends.title')}
          </h2>
          <ul className="flex flex-col gap-2">
            {trends.map((biomarker) => (
              <TrendRow
                key={biomarker.id}
                biomarker={biomarker}
                locale={locale}
                dateLocale={dateLocale}
              />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="shared-history">
        <h2 id="shared-history" className="mb-3 scroll-mt-24 text-base font-semibold text-foreground">
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

      <SharedFlowsheet state={flowsheetState} />
    </div>
  )
}

function FlagRow({
  biomarker,
  locale,
  dateLocale,
}: {
  biomarker: BiomarkerResult
  locale: string
  dateLocale: string
}) {
  const t = useTranslations('sharedView')
  const ts = useTranslations('statuses')
  const unit = biomarker.definition.canonical_unit || biomarker.definition.unit
  // `full` matches the print editor's convention: this block is what a
  // recipient prints and hands to a colleague, so "10B copies/mL" is the wrong
  // register — the value and the reference both render at full precision.
  const reference = formatReference(
    biomarker.reference ?? biomarker.definition.reference,
    unit,
    { full: true, lang: locale },
  )
  const name = biomarkerName(biomarker.definition, locale)
  const original = biomarker.original_name?.trim()
  const valueText = `${formatNumberFull(biomarker.value)}${unit ? ` ${unit}` : ''}`
  const statusWord = biomarker.status ? ts(biomarker.status) : ''
  return (
    <li
      className={cn(
        'rounded-lg border border-border bg-card px-4 py-3',
        'md:grid md:items-center md:rounded-none md:border-0 md:border-b md:border-border md:px-3 md:py-2.5 md:last:border-b-0',
        FLAG_GRID,
      )}
      data-testid="shared-flag-row"
    >
      <div className="min-w-0">
        {/* The name WRAPS at desktop rather than truncating: a clipped
            "Gamma glutamyl transf…" is unrecoverable on a touch screen and on
            paper, and this block is the one a doctor may print and hand over.
            The row grows a line for the handful of long names instead. */}
        <p className="text-sm font-semibold text-foreground">{name}</p>
        {original && original !== name ? (
          <p className="text-xs text-muted-foreground">{original}</p>
        ) : null}
      </div>
      <div className="mt-1 md:mt-0 md:text-right">
        <p
          className={cn(
            'text-lg font-bold tabular-nums md:text-base',
            isOutOfRange(biomarker.status)
              ? STATUS_TEXT_CLASS[biomarker.status]
              : 'text-foreground',
          )}
          // A courtesy for assistive tech, NOT the accessibility guarantee: an
          // `aria-label` on a bare <p> is not reliably exposed. The visible
          // StatusBadge beside it is what actually carries the status in
          // words, and what satisfies §4.4 / WCAG 1.4.1.
          aria-label={`${valueText} — ${statusWord}`}
        >
          {valueText}
        </p>
        {/* `md:truncate` at desktop: the value column is wide enough for the
            date on one line, and a wrapped date line was costing every row an
            extra 16px for no extra information. Below `md` the row is a card
            and the line wraps as before. */}
        <p className="text-xs text-muted-foreground md:truncate">
          {t('flags.measured', { date: formatDay(biomarker.date, dateLocale) })}
        </p>
      </div>
      {/* NOT truncated at `md`: the reference carries uncompacted numbers, and
          "100,000,000,000 – 10,0…" is worse than a second line — a range cut
          mid-number is unreadable. It wraps instead. */}
      <p className="mt-1 text-xs text-muted-foreground md:mt-0 md:text-sm">
        {/* Below `md` the row is a card, so the range needs its own label; at
            `md` the column heading above supplies it. */}
        <span className="md:hidden">{t('flags.reference')}: </span>
        {reference}
      </p>
      <div className="mt-1.5 md:mt-0 md:justify-self-end">
        <StatusBadge status={biomarker.status} />
      </div>
    </li>
  )
}

/**
 * One biomarker's trend: the last three readings, oldest first, each with its
 * own date, and the direction of every step between them.
 *
 * The arrows are deliberately neutral-coloured — "up" is not good news and
 * "down" is not bad news. Which way is better depends on the analyte, and this
 * page does not grade that.
 */
function TrendRow({
  biomarker,
  locale,
  dateLocale,
}: {
  biomarker: BiomarkerResult
  locale: string
  dateLocale: string
}) {
  const t = useTranslations('sharedView')
  const points = trendPoints(biomarker)
  return (
    <li className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-sm font-medium text-foreground">
        {biomarkerName(biomarker.definition, locale)}
      </p>
      <ol className="mt-2 flex flex-wrap items-stretch gap-x-2 gap-y-2">
        {points.map((point, index) => {
          const previous = index > 0 ? points[index - 1] : null
          const direction = previous
            ? trendDirection(previous.value, point.value)
            : null
          const value = formatNumberFull(point.value)
          const date = formatDay(point.date, dateLocale)
          return (
            <li key={`${point.date}-${index}`} className="flex items-stretch gap-2">
              {direction && <DirectionArrow direction={direction} />}
              <span
                className="flex min-w-16 flex-col items-center rounded-md border border-border px-2 py-1"
                aria-label={t('trends.pointLabel', { value, date })}
              >
                <span className="font-mono text-sm font-medium tabular-nums text-foreground">
                  {value}
                </span>
                <span className="text-[11px] text-muted-foreground">{date}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </li>
  )
}

function DirectionArrow({ direction }: { direction: 'up' | 'down' | 'flat' }) {
  const Icon = direction === 'up' ? ArrowUp : direction === 'down' ? ArrowDown : Minus
  return <Icon aria-hidden className="size-3.5 self-center text-muted-foreground" />
}
