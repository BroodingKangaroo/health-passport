'use client'

import { useSearchParams, notFound } from 'next/navigation'
import { BookOpen } from 'lucide-react'

import { cn, formatDate, formatNumber } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { BiomarkerChart } from '@/components/shared/BiomarkerChart'
import { useBiomarkerData } from '@/hooks/useBiomarkerData'
import { formatReference, unitLabel, isQualitative } from '@/lib/reference'
import type { Status, BiomarkerResult } from '@/lib/types'

const statusText: Record<Status, string> = {
  normal: 'text-status-normal',
  low: 'text-status-low',
  high: 'text-status-high',
  abnormal: 'text-status-high',
}

function refText(b: Pick<BiomarkerResult, 'reference' | 'definition'>): string {
  const ref = b.reference ?? b.definition.reference
  return isQualitative(ref) ? formatReference(ref) : formatReference(ref, b.definition.unit)
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
    { entry_id: biomarker.entry_id, date: biomarker.date, value: biomarker.value, status: biomarker.status },
  ]

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="leading-tight">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {biomarker.definition.names.en}{' '}
            <span className="text-muted-foreground/70">/ {biomarker.definition.names.ru}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reference range: {refText(biomarker)}
          </p>
        </div>
        <div
          className={cn(
            'rounded-lg border px-4 py-2 text-right',
            biomarker.status === 'low' &&
              'border-status-low/30 bg-status-low-bg',
            biomarker.status === 'high' &&
              'border-status-high/30 bg-status-high-bg',
            biomarker.status === 'abnormal' &&
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
            {formatNumber(biomarker.value) || '—'} {unitLabel(biomarker.definition.unit, biomarker.reference ?? biomarker.definition.reference)}{' '}
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
              Historical trend · reference band {refText(biomarker)}
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
                {[...chartData].reverse().map((entry, idx) => (
                  <div
                    key={`${entry.date}-${idx}`}
                    className="grid grid-cols-[1fr_1fr_1fr] items-center gap-x-3 border-b border-border px-4 py-3 text-sm transition-colors last:border-0 hover:bg-muted/40"
                  >
                    <span className="text-muted-foreground">{formatDate(entry.date)}</span>
                    <span
                      className={cn(
                        'font-semibold tabular-nums',
                        statusText[entry.status],
                      )}
                    >
                      {formatNumber(entry.value)} {unitLabel(biomarker.definition.unit, biomarker.reference ?? biomarker.definition.reference)}
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
              {biomarker.definition.names.en} is measured at{' '}
              {formatNumber(biomarker.value) || '—'} {unitLabel(biomarker.definition.unit, biomarker.reference ?? biomarker.definition.reference)}. The standard reference range
              is {refText(biomarker)}.
            </p>
          </Card>


        </div>
      </div>
    </div>
  )
}
