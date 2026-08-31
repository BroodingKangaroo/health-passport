'use client'

import { ArrowRight } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { cn, formatDate, formatNumber, sortReadingsByDate } from '@/lib/utils'
import { localizedStatus } from '@/lib/status-labels'
import { Button } from '@/components/ui/button'
import { BiomarkerChart } from '@/components/shared/BiomarkerChart'
import { ScaleNote } from '@/components/shared/ScaleNote'
import { formatReference, unitLabel, displayUnit } from '@/lib/reference'
import { qualitativeLabel } from '@/lib/qualitative-labels'
import type { BiomarkerResult, Reading, Status } from '@/lib/types'

const statusText: Record<Status, string> = {
  normal: 'text-status-normal',
  low: 'text-status-low',
  high: 'text-status-high',
  abnormal: 'text-status-high',
}

function MetricCard({
  label,
  value,
  unit,
  highlight,
}: {
  label: string
  value: string
  unit: string
  highlight?: string
}) {
  return (
    <div className="flex-1 rounded-lg border border-border bg-card px-3 py-2.5 text-center">
      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={cn('mt-0.5 text-base font-bold text-foreground', highlight)}>
        {value}
      </p>
      <p className="text-[10px] text-muted-foreground">{unit}</p>
    </div>
  )
}

export function ExpandedBiomarkerDetails({
  biomarker,
  onViewDetails,
}: {
  biomarker: BiomarkerResult
  onViewDetails?: () => void
}) {
  const t = useTranslations('timeline.biomarker')
  const tRoot = useTranslations()
  const locale = useLocale()
  const history = biomarker.history ?? []
  const current: Reading = {
    entry_id: biomarker.entry_id,
    date: biomarker.date,
    value: biomarker.value,
    status: biomarker.status,
  }
  // `history` excludes the reading at the selected event, which arrives as the
  // top-level fields. TimelineView.biomarkersAtDate promotes ANY selected
  // event's reading to that slot, so appending it after history can place a
  // mid-series reading last — sort chronologically so the chart x-axis and the
  // reversed reading-history chips below stay time-ordered. Do NOT filter by
  // date here: that would silently drop an older reading that happens to share
  // the selected day (e.g. two panels on the same date) and diverge from
  // biomarker-details.tsx.
  const chartData = sortReadingsByDate([...history, current])
  const effRef = biomarker.reference ?? biomarker.definition.reference
  const unitDisplay = unitLabel(displayUnit(biomarker.definition), effRef, locale)
  const numericValues = chartData
    .map((d) => d.value)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const peak = numericValues.length ? Math.max(...numericValues) : null
  const trough = numericValues.length ? Math.min(...numericValues) : null
  const peakReading = peak != null ? chartData.find((d) => d.value === peak) : undefined
  const peakStatus: Status = (peakReading?.status as Status) ?? 'normal'
  const troughReading = trough != null ? chartData.find((d) => d.value === trough) : undefined
  const troughStatus: Status = (troughReading?.status as Status) ?? 'normal'

  return (
    <div className="flex flex-col gap-5 rounded-lg bg-muted/60 p-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {t('dynamics', { name: biomarker.definition.names.en })}
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          {t('reference', {
            value: formatReference(biomarker.reference ?? biomarker.definition.reference, null, { lang: locale }),
          })}
        </p>
        <BiomarkerChart biomarker={biomarker} data={chartData} height={250} />
      </div>

      <div className="flex gap-3">
        <MetricCard
          label={t('metricLatest')}
          value={biomarker.value == null ? '—' : qualitativeLabel(formatNumber(biomarker.value), locale)}
          unit={unitDisplay}
          highlight={statusText[biomarker.status]}
        />
        <MetricCard
          label={t('metricPeak')}
          value={peak == null ? '—' : formatNumber(peak)}
          unit={unitDisplay}
          highlight={statusText[peakStatus]}
        />
        <MetricCard
          label={t('metricTrough')}
          value={trough == null ? '—' : formatNumber(trough)}
          unit={unitDisplay}
          highlight={statusText[troughStatus]}
        />
      </div>

      <div className="flex flex-col gap-4 border-t border-border pt-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 flex-1">
          <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">
            {t('readingHistory')}
          </h4>
          <ul className="flex flex-wrap gap-2">
            {(() => {
              // chartData is chronological, so reversed walks newest →
              // oldest. The selected event's reading is the `current` object,
              // not part of history; every other item IS its own history
              // entry, which carries scale_function / needs_review /
              // original_* on the reading. Match by identity — positional
              // indexing into `history` would break once chartData is sorted.
              const reversed = [...chartData].reverse()
              return reversed.map((reading, i) => {
                const corresponding = reading === current ? undefined : reading
                return (
                  <li
                    key={`${reading.date}-${i}`}
                    className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                  >
                    <span className="text-muted-foreground">{formatDate(reading.date, locale)}</span>
                    <span className="font-semibold text-foreground">
                      {qualitativeLabel(formatNumber(reading.value), locale)} {unitDisplay}
                      <ScaleNote
                        className="ml-1"
                        scaleFunction={corresponding?.scale_function}
                        needsReview={corresponding?.needs_review}
                        originalValue={corresponding?.original_value}
                        originalUnit={corresponding?.original_unit}
                      />
                    </span>
                    <span
                      className={cn(
                        'font-medium capitalize',
                        statusText[reading.status as Status],
                      )}
                    >
                      {localizedStatus(reading.status, tRoot)}
                    </span>
                  </li>
                )
              })
            })()}
          </ul>
        </div>
        <Button
          variant="outline"
          onClick={onViewDetails}
          className="shrink-0 border-primary/30 bg-accent text-accent-foreground hover:bg-accent/70"
        >
          {t('viewFullDetails')}
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
