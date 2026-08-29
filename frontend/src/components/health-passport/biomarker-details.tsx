'use client'

import { useSearchParams, notFound } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { BookOpen } from 'lucide-react'

import { cn, formatDate, formatNumber } from '@/lib/utils'
import { localizedStatus } from '@/lib/status-labels'
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
  const t = useTranslations('timeline.biomarker')
  const tc = useTranslations('common')
  const tRoot = useTranslations()
  const locale = useLocale()

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl py-20 text-center text-sm text-muted-foreground">
        {tc('loading')}
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
            {t('referenceRange', { value: refText(biomarker) })}
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
            {t('current')}
          </p>
          <p className={cn('text-lg font-bold', statusText[biomarker.status])}>
            {formatNumber(biomarker.value) || '—'} {unitLabel(biomarker.definition.unit, biomarker.reference ?? biomarker.definition.reference)}{' '}
            <span className="text-sm font-semibold capitalize">
              ({localizedStatus(biomarker.status, tRoot)})
            </span>
          </p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-5">
          <Card className="border-border p-4">
            <h2 className="text-sm font-semibold text-foreground">
              {t('allTimeDynamics')}
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              {t('historicalTrend', { value: refText(biomarker) })}
            </p>
            <BiomarkerChart biomarker={biomarker} data={chartData} height={350} />
          </Card>

          <Card className="overflow-hidden border-border">
            <div className="border-b border-border p-4">
              <h2 className="text-sm font-semibold text-foreground">
                {t('readingHistoryTable')}
              </h2>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[400px]">
                <div className="grid grid-cols-[1fr_1fr_1fr] gap-x-3 border-b border-border bg-muted/40 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>{t('colDate')}</span>
                  <span>{t('colValue')}</span>
                  <span>{t('colStatus')}</span>
                </div>
                {[...chartData].reverse().map((entry, idx) => (
                  <div
                    key={`${entry.date}-${idx}`}
                    className="grid grid-cols-[1fr_1fr_1fr] items-center gap-x-3 border-b border-border px-4 py-3 text-sm transition-colors last:border-0 hover:bg-muted/40"
                  >
                    <span className="text-muted-foreground">{formatDate(entry.date, locale)}</span>
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
                      {localizedStatus(entry.status, tRoot)}
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
                {t('about')}
              </h2>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t('aboutSentence', {
                name: biomarker.definition.names.en,
                value: formatNumber(biomarker.value) || '—',
                unit: unitLabel(biomarker.definition.unit, biomarker.reference ?? biomarker.definition.reference),
                ref: refText(biomarker),
              })}
            </p>
          </Card>


        </div>
      </div>
    </div>
  )
}
