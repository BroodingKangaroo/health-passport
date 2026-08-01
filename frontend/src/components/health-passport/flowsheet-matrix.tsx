'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, ChevronRight, ArrowDown, ArrowUp } from 'lucide-react'

import { cn, formatNumber } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Sparkline } from '@/components/shared/Sparkline'
import { ScaleNote } from '@/components/shared/ScaleNote'
import { formatReference, intervalBounds, qualitativeToNumber, isQualitative } from '@/lib/reference'
import type { DateHeader, MatrixCategory, MatrixCell, BiomarkerResult, Status, MatrixRow } from '@/lib/types'

const statusText: Record<Status, string> = {
  normal: 'text-foreground',
  low: 'text-status-low',
  high: 'text-status-high',
  abnormal: 'text-status-high',
}

function Cell({ cell }: { cell: MatrixCell }) {
  const isOut = cell.status !== 'normal'
  return (
    <span
      className={cn(
        'flex items-center justify-end gap-1 tabular-nums',
        isOut ? cn('font-bold', statusText[cell.status]) : 'text-foreground',
      )}
    >
      {formatNumber(cell.value)}
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
            Longitudinal Lab Flowsheet
          </h2>
          <p className="text-xs text-muted-foreground">
            Tracking biomarker values across all recorded lab panels
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter biomarkers..."
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
            <span>Biomarker / Reference range</span>
            <span className="text-left">TREND</span>
            {dates.map((date, i) => (
              <span key={`${date.label}-${i}`} className="text-right leading-tight">
                <span>
                  {date.label}
                  {i === dates.length - 1 && (
                    <span className="ml-1 text-primary">(Latest)</span>
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
                const history = bioResults
                  .map((b) => {
                    if (typeof b.value === 'number' && Number.isFinite(b.value)) return { value: b.value as number, status: b.status }
                    const qn = qualitativeToNumber(b.value)
                    if (qn != null) return { value: qn, status: b.status }
                    return null
                  })
                  .filter((h) => h != null) as { value: number; status: string }[]
                const hasBio = bioResults.length > 0
                const bounds = isQualitative(row.reference) ? { low: 0, high: 1 } : intervalBounds(row.reference)
                return (
                  <div
                    key={row.id}
                    onClick={() => {
                      if (hasBio) {
                        router.push('/details?id=' + row.id + '&from=flowsheet')
                      }
                    }}
                    className={cn(
                      'grid',
                      GRID_COLS,
                      'border-b border-border px-4 py-3 text-sm transition-colors',
                      hasBio && 'cursor-pointer hover:bg-muted/50',
                    )}
                    style={{ gridTemplateColumns: gridTemplateCols }}
                  >
                    <div className="min-w-0 leading-tight">
                      <p className="truncate font-semibold text-foreground">
                        {row.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground/70">
                        {row.original} · {formatReference(row.reference, row.unit)}

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
                ? `No biomarkers match \u201c${query}\u201d.`
                : 'No biomarkers recorded for this entry.'}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
