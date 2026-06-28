'use client'

import { ArrowRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BiomarkerChart } from '@/components/shared/BiomarkerChart'
import type { BiomarkerResult, Status } from '@/lib/types'

const statusText: Record<Status, string> = {
  normal: 'text-status-normal',
  low: 'text-status-low',
  high: 'text-status-high',
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
  const chartData = [
    ...history,
    { date: biomarker.date, value: biomarker.value, status: biomarker.status },
  ]
  const allValues = chartData.map((d) => d.value)
  const peak = Math.max(...allValues)
  const trough = Math.min(...allValues)
  const peakReading = chartData.find((d) => d.value === peak)
  const peakStatus = peakReading?.status ?? 'normal'
  const troughReading = chartData.find((d) => d.value === trough)
  const troughStatus = troughReading?.status ?? 'normal'

  return (
    <div className="flex flex-col gap-5 rounded-lg bg-muted/60 p-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {biomarker.definition.name_en} Dynamics
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Reference: {biomarker.definition.range_min} – {biomarker.definition.range_max} {biomarker.definition.unit}
        </p>
        <BiomarkerChart biomarker={biomarker} data={chartData} height={250} />
      </div>

      <div className="flex gap-3">
        <MetricCard
          label="LATEST"
          value={`${biomarker.value}`}
          unit={biomarker.definition.unit}
          highlight={statusText[biomarker.status]}
        />
        <MetricCard
          label="PEAK"
          value={`${peak}`}
          unit={biomarker.definition.unit}
          highlight={statusText[peakStatus]}
        />
        <MetricCard
          label="TROUGH"
          value={`${trough}`}
          unit={biomarker.definition.unit}
          highlight={statusText[troughStatus]}
        />
      </div>

      <div className="flex flex-col gap-4 border-t border-border pt-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 flex-1">
          <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">
            READING HISTORY
          </h4>
          <ul className="flex flex-wrap gap-2">
            {chartData.map((reading) => (
              <li
                key={reading.date}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
              >
                <span className="text-muted-foreground">{reading.date}</span>
                <span className="font-semibold text-foreground">
                  {reading.value} {biomarker.definition.unit}
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
