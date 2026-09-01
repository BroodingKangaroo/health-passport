'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Search, ChevronRight, ArrowDown, ArrowUp } from 'lucide-react'

import { cn, formatNumber } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Sparkline } from '@/components/shared/Sparkline'
import { ScaleNote } from '@/components/shared/ScaleNote'
import { formatReference, isQualitative } from '@/lib/reference'
import { coerceChartValue, chartReferenceBounds } from '@/lib/chart-series'
import { qualitativeLabel } from '@/lib/qualitative-labels'
import { activateOnKey } from '@/lib/a11y'
import { STATUS_TEXT_CLASS as statusText } from '@/lib/status-labels'
import type { DateHeader, MatrixCategory, MatrixCell, BiomarkerResult } from '@/lib/types'

function Cell({ cell }: { cell: MatrixCell }) {
  const locale = useLocale()
  const isOut = cell.status !== 'normal'
  return (
    <span
      className={cn(
        'flex items-center justify-end gap-1 tabular-nums',
        isOut ? cn('font-bold', statusText[cell.status]) : 'text-foreground',
      )}
    >
      {qualitativeLabel(formatNumber(cell.value), locale)}
      <ScaleNote
        className="ml-0.5"
        scaleFunction={cell.scale_function}
        needsReview={cell.needs_review}
      />
      {cell.status === 'low' && <ArrowDown className="size-3.5" />}
      {cell.status === 'high' && <ArrowUp className="size-3.5" />}
    </span>
  )
}

interface FlowsheetMatrixProps {
  dates: readonly DateHeader[]
  matrix: MatrixCategory[]
  biomarkers: BiomarkerResult[]
}

export function FlowsheetMatrix({ dates, matrix, biomarkers }: FlowsheetMatrixProps) {
  const router = useRouter()
  const t = useTranslations('timeline.flowsheet')
  const locale = useLocale()
  const [query, setQuery] = useState('')

  const dateCols = dates.map(() => '1fr').join(' ')
  const gridTemplateCols = `1.5fr 100px ${dateCols} 32px`
  const GRID_COLS = 'items-center gap-x-3'

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return matrix
    return matrix
      .map((cat) => ({
        ...cat,
        rows: cat.rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.original.toLowerCase().includes(q),
        ),
      }))
      .filter((cat) => cat.rows.length > 0)
  }, [query, matrix])

  return (
    <Card className="overflow-hidden border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="leading-tight">
          <h2 className="text-base font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('filterPlaceholder')}
            className="pl-8"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[960px]">
          <div
            className={cn(
              'grid',
              GRID_COLS,
              'border-b border-border bg-muted/40 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
            )}
            style={{ gridTemplateColumns: gridTemplateCols }}
          >
            <span>{t('colBiomarkerReference')}</span>
            <span className="text-left">{t('colTrend')}</span>
            {dates.map((date, i) => (
              <span key={`${date.label}-${i}`} className="text-right leading-tight">
                <span className="block whitespace-nowrap">
                  {date.label}
                  {i === dates.length - 1 && (
                    <span className="ml-1 text-primary">{t('latest')}</span>
                  )}
                </span>
                {date.sub && (
                  <span className="block text-[9px] text-muted-foreground/60">{date.sub}</span>
                )}
              </span>
            ))}
            <span aria-hidden />
          </div>

          {filtered.map((cat) => (
            <div key={cat.category}>
              <div className="border-b border-border bg-secondary px-4 py-2 text-xs font-bold uppercase tracking-wide text-secondary-foreground">
                {cat.category}
              </div>
              {cat.rows.map((row) => {
                const bioResults = biomarkers.filter((b) => b.definition.id === row.id)
                const qual = isQualitative(row.reference)
                const history = bioResults
                  .map((b) => {
                    const v = coerceChartValue(b.value, qual)
                    return v == null ? null : { value: v, status: b.status }
                  })
                  .filter((h) => h != null) as { value: number; status: string }[]
                const hasBio = bioResults.length > 0
                const bounds = chartReferenceBounds(row.reference)
                return (
                  <div
                    key={row.id}
                    role={hasBio ? 'button' : undefined}
                    tabIndex={hasBio ? 0 : undefined}
                    aria-disabled={hasBio ? undefined : true}
                    onClick={() => {
                      if (hasBio) {
                        router.push('/details?id=' + row.id + '&from=flowsheet')
                      }
                    }}
                    onKeyDown={(e) => {
                      if (hasBio) activateOnKey(e, () => router.push('/details?id=' + row.id + '&from=flowsheet'))
                    }}
                    className={cn(
                      'grid',
                      GRID_COLS,
                      'border-b border-border px-4 py-3 text-sm transition-colors',
                      hasBio && 'group cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none',
                    )}
                    style={{ gridTemplateColumns: gridTemplateCols }}
                  >
                    <div className="min-w-0 leading-tight">
                      <p className="truncate font-semibold text-foreground">
                        {row.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground/70">
                        {row.original} · {formatReference(row.reference, row.unit, { lang: locale })}

                      </p>
                    </div>
                    <Sparkline
                      id={row.id}
                      history={history}
                      refMin={bounds?.low ?? undefined}
                      refMax={bounds?.high ?? undefined}
                    />
                    {row.cells.map((cell, i) => (
                      <Cell key={i} cell={cell} />
                    ))}
                    {hasBio ? (
                      <span className="flex items-center justify-end text-muted-foreground transition-colors group-hover:text-foreground">
                        <ChevronRight className="size-4" />
                      </span>
                    ) : (
                      <span />
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {filtered.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {query
                ? t('emptySearch', { query })
                : t('empty')}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
