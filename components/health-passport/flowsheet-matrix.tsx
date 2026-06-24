'use client'

import { useMemo, useState } from 'react'
import { Search, ArrowDown, ArrowUp } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  flowsheetDates,
  flowsheetMatrix,
  type MatrixCell,
  type Status,
} from './data'

const GRID_COLS = 'grid grid-cols-[2fr_1fr_1fr_1fr_1fr] items-center gap-x-3'

const statusText: Record<Status, string> = {
  normal: 'text-foreground',
  low: 'text-status-low',
  high: 'text-status-high',
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
      {cell.value}
      {cell.status === 'low' && <ArrowDown className="size-3.5" />}
      {cell.status === 'high' && <ArrowUp className="size-3.5" />}
    </span>
  )
}

export function FlowsheetMatrix() {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return flowsheetMatrix
    return flowsheetMatrix
      .map((cat) => ({
        ...cat,
        rows: cat.rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.original.toLowerCase().includes(q),
        ),
      }))
      .filter((cat) => cat.rows.length > 0)
  }, [query])

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
        <div className="min-w-[760px]">
          {/* Header */}
          <div
            className={cn(
              GRID_COLS,
              'border-b border-border bg-muted/40 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
            )}
          >
            <span>Biomarker / Range</span>
            {flowsheetDates.map((date, i) => (
              <span key={date} className="text-right">
                {date}
                {i === flowsheetDates.length - 1 && (
                  <span className="ml-1 text-primary">(Latest)</span>
                )}
              </span>
            ))}
          </div>

          {/* Categories */}
          {filtered.map((cat) => (
            <div key={cat.category}>
              <div className="border-b border-border bg-secondary px-4 py-2 text-xs font-bold uppercase tracking-wide text-secondary-foreground">
                {cat.category}
              </div>
              {cat.rows.map((row) => (
                <div
                  key={row.id}
                  className={cn(
                    GRID_COLS,
                    'border-b border-border px-4 py-3 text-sm transition-colors hover:bg-muted/40',
                  )}
                >
                  <div className="min-w-0 leading-tight">
                    <p className="truncate font-semibold text-foreground">
                      {row.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground/70">
                      {row.original} · {row.range}
                    </p>
                  </div>
                  {row.cells.map((cell, i) => (
                    <Cell key={i} cell={cell} />
                  ))}
                </div>
              ))}
            </div>
          ))}

          {filtered.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No biomarkers match &ldquo;{query}&rdquo;.
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
