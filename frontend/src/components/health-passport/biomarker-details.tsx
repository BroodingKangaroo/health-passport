'use client'

import { useMemo } from 'react'
import { useSearchParams, notFound } from 'next/navigation'
import { ArrowDown, Sparkles, BookOpen } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { BiomarkerChart } from '@/components/shared/BiomarkerChart'
import { useBiomarkerData } from '@/hooks/useBiomarkerData'
import type { Status } from '@/lib/types'

const statusText: Record<Status, string> = {
  normal: 'text-status-normal',
  low: 'text-status-low',
  high: 'text-status-high',
}

export function BiomarkerDetails() {
  const searchParams = useSearchParams()
  const id = searchParams.get('id')
  const { data: biomarker, isLoading, error } = useBiomarkerData(id)

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl py-20 text-center text-sm text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (error || !biomarker) {
    notFound()
  }

  const history = biomarker.history ?? []
  const chartData = [
    ...history,
    { date: biomarker.date, value: biomarker.value, status: biomarker.status },
  ]

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="leading-tight">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {biomarker.definition.name_en}{' '}
            <span className="text-muted-foreground/70">/ {biomarker.definition.name_ru}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reference range: {biomarker.definition.range_min} – {biomarker.definition.range_max} {biomarker.definition.unit}
          </p>
        </div>
        <div
          className={cn(
            'rounded-lg border px-4 py-2 text-right',
            biomarker.status === 'low' &&
              'border-status-low/30 bg-status-low-bg',
            biomarker.status === 'high' &&
              'border-status-high/30 bg-status-high-bg',
            biomarker.status === 'normal' &&
              'border-status-normal/30 bg-status-normal-bg',
          )}
        >
          <p
            className={cn(
              'text-[10px] font-semibold uppercase tracking-wide',
              statusText[biomarker.status],
            )}
          >
            Current
          </p>
          <p className={cn('text-lg font-bold', statusText[biomarker.status])}>
            {biomarker.value} {biomarker.definition.unit}{' '}
            <span className="text-sm font-semibold capitalize">
              ({biomarker.status})
            </span>
          </p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-5">
          <Card className="border-border p-4">
            <h2 className="text-sm font-semibold text-foreground">
              All-Time Dynamics
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Historical trend · reference band {biomarker.definition.range_min} –{' '}
              {biomarker.definition.range_max} {biomarker.definition.unit}
            </p>
            <BiomarkerChart biomarker={biomarker} data={chartData} height={350} />
          </Card>

          <Card className="overflow-hidden border-border">
            <div className="border-b border-border p-4">
              <h2 className="text-sm font-semibold text-foreground">
                Reading History
              </h2>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[400px]">
                <div className="grid grid-cols-[1fr_1fr_1fr] gap-x-3 border-b border-border bg-muted/40 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Date</span>
                  <span>Value</span>
                  <span>Status</span>
                </div>
                {chartData.map((entry) => (
                  <div
                    key={entry.date}
                    className="grid grid-cols-[1fr_1fr_1fr] items-center gap-x-3 border-b border-border px-4 py-3 text-sm transition-colors last:border-0 hover:bg-muted/40"
                  >
                    <span className="text-muted-foreground">{entry.date}</span>
                    <span
                      className={cn(
                        'font-semibold tabular-nums',
                        statusText[entry.status],
                      )}
                    >
                      {entry.value} {biomarker.definition.unit}
                    </span>
                    <span
                      className={cn(
                        'font-medium capitalize',
                        statusText[entry.status],
                      )}
                    >
                      {entry.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="border-border p-4">
            <div className="mb-2 flex items-center gap-2">
              <BookOpen className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">
                About this Biomarker
              </h2>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {biomarker.definition.name_en} ({biomarker.definition.name_ru}) is measured at{' '}
              {biomarker.value} {biomarker.definition.unit}. The standard reference range
              is {biomarker.definition.range_min} – {biomarker.definition.range_max} {biomarker.definition.unit}.
            </p>
          </Card>

          {id === 'ferritin' && (
            <Card className="border-primary/20 bg-accent p-4">
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="size-4 text-primary" />
                <h2 className="text-sm font-semibold text-accent-foreground">
                  Clinical Notes & AI Insights
                </h2>
              </div>
              <ul className="space-y-3 text-sm text-accent-foreground">
                <li className="flex gap-2">
                  <ArrowDown className="mt-0.5 size-4 shrink-0 text-status-low" />
                  <span>Ferritin levels dropped by 30% since August.</span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span>
                    Correlates with recent fatigue reported in Cardiologist visit.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span>
                    <span className="font-semibold">Action recommended:</span>{' '}
                    Discuss IV Iron infusion or oral supplements with your physician.
                  </span>
                </li>
              </ul>
              <div className="mt-4">
                <Badge variant="low">Requires follow-up</Badge>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
