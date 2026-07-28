'use client'

import { ArrowRight } from 'lucide-react'

import { cn, formatDate, formatNumber } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BiomarkerChart } from '@/components/shared/BiomarkerChart'
import { formatReference, unitLabel, isQualitative } from '@/lib/reference'
import type { BiomarkerResult, Status } from '@/lib/types'

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
  const history = biomarker.history ?? []
  // The backend `history` already excludes the latest reading, so the full
  // series is history + the current reading. Do NOT filter by date here: that
  // would silently drop an older reading that happens to share the latest day
  // (e.g. two panels on the same date) and diverge from biomarker-details.tsx.
  const chartData = [
    ...history,
    { date: biomarker.date, value: biomarker.value, status: biomarker.status },
  ]
  const effRef = biomarker.reference ?? biomarker.definition.reference
  const unitDisplay = unitLabel(biomarker.definition.unit, effRef)
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
          {biomarker.definition.names.en} Dynamics
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Reference: {formatReference(biomarker.reference ?? biomarker.definition.reference)}
        </p>
        <BiomarkerChart biomarker={biomarker} data={chartData} height={250} />
      </div>

      <div className="flex gap-3">
        <MetricCard
          label="LATEST"
          value={biomarker.value == null ? '—' : formatNumber(biomarker.value)}
          unit={unitDisplay}
          highlight={statusText[biomarker.status]}
        />
        <MetricCard
          label="PEAK"
          value={peak == null ? '—' : formatNumber(peak)}
          unit={unitDisplay}
          highlight={statusText[peakStatus]}
        />
        <MetricCard
          label="TROUGH"
          value={trough == null ? '—' : formatNumber(trough)}
          unit={unitDisplay}
          highlight={statusText[troughStatus]}
        />
      </div>

      <div className="flex flex-col gap-4 border-t border-border pt-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 flex-1">
          <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">
            READING HISTORY
          </h4>
          <ul className="flex flex-wrap gap-2">
            {[...chartData].reverse().map((reading, i) => (
              <li
                key={`${reading.date}-${i}`}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
              >
                <span className="text-muted-foreground">{formatDate(reading.date)}</span>
                <span className="font-semibold text-foreground">
                  {formatNumber(reading.value)} {unitLabel(biomarker.definition.unit, biomarker.reference ?? biomarker.definition.reference)}
                </span>
                <span
                  className={cn(
                    'font-medium capitalize',
                    statusText[reading.status as Status],
                  )}
                >
                  {reading.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <Button
          variant="outline"
          onClick={onViewDetails}
          className="shrink-0 border-primary/30 bg-accent text-accent-foreground hover:bg-accent/70"
        >
          View Full Biomarker Details
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
