'use client'

import { useMemo, useState } from 'react'
import {
  Search,
  ChevronDown,
  ChevronUp,
  Check,
  ArrowDown,
  ArrowUp,
  ArrowRight,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { biomarkers, type Biomarker, type Status } from './data'
import { BiomarkerChart } from './biomarker-chart'

const GRID_COLS =
  'grid grid-cols-[1.5fr_1.5fr_1fr_1fr_1fr_1.2fr_40px] items-center gap-x-3'

function StatusBadge({ status }: { status: Status }) {
  if (status === 'normal') {
    return (
      <Badge variant="normal">
        <Check className="size-3" />
        Normal
      </Badge>
    )
  }
  if (status === 'low') {
    return (
      <Badge variant="low">
        <ArrowDown className="size-3" />
        Low
      </Badge>
    )
  }
  return (
    <Badge variant="high">
      <ArrowUp className="size-3" />
      High
    </Badge>
  )
}

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

function ExpandedPanel({
  biomarker,
  onViewDetails,
}: {
  biomarker: Biomarker
  onViewDetails?: () => void
}) {
  const history = biomarker.history ?? []
  const values = history.map((h) => h.value)
  const peak = Math.max(...values)
  const trough = Math.min(...values)
  const peakStatus = history.find((h) => h.value === peak)?.status ?? 'normal'
  const troughStatus = history.find((h) => h.value === trough)?.status ?? 'normal'

  return (
    <div className="flex flex-col gap-5 rounded-lg bg-muted/60 p-5">
      {/* A. Chart */}
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {biomarker.name} Dynamics
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Reference: {biomarker.range} {biomarker.unit}
        </p>
        <BiomarkerChart biomarker={biomarker} />
      </div>

      {/* B. Summary metrics */}
      <div className="flex gap-3">
        <MetricCard
          label="LATEST"
          value={biomarker.result}
          unit={biomarker.unit}
          highlight={statusText[biomarker.status]}
        />
        <MetricCard
          label="PEAK"
          value={`${peak}`}
          unit={biomarker.unit}
          highlight={statusText[peakStatus]}
        />
        <MetricCard
          label="TROUGH"
          value={`${trough}`}
          unit={biomarker.unit}
          highlight={statusText[troughStatus]}
        />
      </div>

      {/* C. Reading history + action */}
      <div className="flex flex-col gap-4 border-t border-border pt-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 flex-1">
          <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">
            READING HISTORY
          </h4>
          <ul className="flex flex-wrap gap-2">
            {history.map((reading) => (
              <li
                key={reading.date}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
              >
                <span className="text-muted-foreground">{reading.date}</span>
                <span className="font-semibold text-foreground">
                  {reading.value} {biomarker.unit}
                </span>
                <span
                  className={cn(
                    'font-medium capitalize',
                    statusText[reading.status],
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

export function ResultsPanel({
  onViewDetails,
}: {
  onViewDetails?: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>('ferritin')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return biomarkers
    return biomarkers.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.original.toLowerCase().includes(q),
    )
  }, [query])

  return (
    <Card className="overflow-hidden border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="leading-tight">
          <h2 className="text-base font-semibold text-foreground">
            Blood Test Results
          </h2>
          <p className="text-xs text-muted-foreground">
            Oct 12, 2026 • Translated from original Russian lab report
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search biomarkers..."
            className="pl-8"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          {/* Header */}
          <div
            className={cn(
              GRID_COLS,
              'border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
            )}
          >
            <span>Biomarker (EN)</span>
            <span>Original (RU)</span>
            <span>Latest</span>
            <span>Unit</span>
            <span>Range</span>
            <span>Status</span>
            <span aria-hidden />
          </div>

          {/* Rows */}
          {filtered.map((b) => {
            const expandable = Boolean(b.history?.length)
            const isOpen = expandedId === b.id && expandable
            return (
              <FlowRow
                key={b.id}
                biomarker={b}
                expandable={expandable}
                isOpen={isOpen}
                onToggle={() =>
                  expandable &&
                  setExpandedId((cur) => (cur === b.id ? null : b.id))
                }
                onViewDetails={onViewDetails}
              />
            )
          })}

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

function FlowRow({
  biomarker,
  expandable,
  isOpen,
  onToggle,
  onViewDetails,
}: {
  biomarker: Biomarker
  expandable: boolean
  isOpen: boolean
  onToggle: () => void
  onViewDetails?: (id: string) => void
}) {
  return (
    <div className={cn('border-b border-border', isOpen && 'bg-muted/40')}>
      <div
        onClick={onToggle}
        className={cn(
          GRID_COLS,
          'px-4 py-3 text-sm transition-colors',
          expandable && 'cursor-pointer hover:bg-muted/50',
        )}
      >
        <span className="truncate font-semibold text-foreground">
          {biomarker.name}
        </span>
        <span className="truncate text-xs text-muted-foreground/70">
          {biomarker.original}
        </span>
        <span className="font-medium text-foreground">{biomarker.result}</span>
        <span className="text-muted-foreground">{biomarker.unit}</span>
        <span className="text-muted-foreground">{biomarker.range}</span>
        <span>
          <StatusBadge status={biomarker.status} />
        </span>
        <span className="flex justify-end">
          {expandable ? (
            isOpen ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )
          ) : (
            <ChevronDown className="size-4 text-muted-foreground/30" />
          )}
        </span>
      </div>

      {isOpen && (
        <div className="px-3 pb-3">
          <ExpandedPanel
            biomarker={biomarker}
            onViewDetails={
              onViewDetails ? () => onViewDetails(biomarker.id) : undefined
            }
          />
        </div>
      )}
    </div>
  )
}
