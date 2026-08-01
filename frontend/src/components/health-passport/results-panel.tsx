'use client'

import { useMemo, useState } from 'react'
import {
  Search,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

import { cn, formatDate, formatNumber } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { formatReference, unitLabel, displayUnit } from '@/lib/reference'
import { ExpandedBiomarkerDetails } from './expanded-biomarker-details'
import type { BiomarkerResult, Status, MergedSource } from '@/lib/types'

const GRID_COLS =
  'grid grid-cols-[1.5fr_1.5fr_1fr_1fr_1fr_1.2fr_40px] items-center gap-x-3'

const statusText: Record<Status, string> = {
  normal: 'text-status-normal',
  low: 'text-status-low',
  high: 'text-status-high',
  abnormal: 'text-status-high',
}

export function ResultsPanel({
  biomarkers,
  labName,
  date,
  onViewDetails,
}: {
  biomarkers: BiomarkerResult[]
  labName: string
  date: string
  onViewDetails?: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return biomarkers
    return biomarkers.filter(
      (b) =>
        b.definition.names.en.toLowerCase().includes(q) ||
        b.definition.names.ru.toLowerCase().includes(q),
    )
  }, [query, biomarkers])

  // Original readings first, then merged-in ones grouped by the upload that
  // contributed them (same title/clinic/provider/time = same group). A merged
  // entry's biomarkers are either original-only or merged-only (the merge
  // conflict check forbids duplicates), so the split is unambiguous.
  const { originalList, mergedGroups } = useMemo(() => {
    const originals: BiomarkerResult[] = []
    const groups = new Map<string, { source: MergedSource | null; rows: BiomarkerResult[] }>()
    for (const b of filtered) {
      if (!b.merged) {
        originals.push(b)
        continue
      }
      const source = b.merged_source ?? null
      const key = JSON.stringify(source)
      let group = groups.get(key)
      if (!group) {
        group = { source, rows: [] }
        groups.set(key, group)
      }
      group.rows.push(b)
    }
    return { originalList: originals, mergedGroups: [...groups.values()] }
  }, [filtered])

  return (
    <Card className="overflow-hidden border-border">
      <div className="flex flex-nowrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0 leading-tight">
          <h2 className="text-base font-semibold text-foreground">
            Blood Test Results
          </h2>
          <p className="truncate text-xs text-muted-foreground" title={`${formatDate(date)} · ${labName}`}>
            {formatDate(date)} · {labName}
          </p>
        </div>
        <div className="relative shrink-0 sm:w-64">
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
          <div
            className={cn(
              GRID_COLS,
              'border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
            )}
          >
            <span>Biomarker (EN)</span>
            <span>Original Name</span>
            <span>Latest</span>
            <span>Unit</span>
            <span>Reference range</span>
            <span>Status</span>
            <span aria-hidden />
          </div>

          {originalList.map((b) => (
            <FlowRow
              key={b.id}
              biomarker={b}
              expandable={true}
              isOpen={expandedId === b.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === b.id ? null : b.id))
              }
              onViewDetails={onViewDetails}
            />
          ))}

          {mergedGroups.map((group) => (
            <div key={JSON.stringify(group.source)}>
              <MergedSectionHeader source={group.source} />
              {group.rows.map((b) => (
                <FlowRow
                  key={b.id}
                  biomarker={b}
                  expandable={true}
                  isOpen={expandedId === b.id}
                  onToggle={() =>
                    setExpandedId((cur) => (cur === b.id ? null : b.id))
                  }
                  onViewDetails={onViewDetails}
                />
              ))}
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

function FlowRow({
  biomarker,
  expandable,
  isOpen,
  onToggle,
  onViewDetails,
}: {
  biomarker: BiomarkerResult
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
          {biomarker.definition.names.en}
        </span>
        <span className="truncate text-xs text-muted-foreground/70">
          {biomarker.original_name || biomarker.definition.names.ru}
        </span>
        <span className="font-medium text-foreground">
          {formatNumber(biomarker.value) || '—'}
        </span>
        <span className="text-muted-foreground">
          {unitLabel(displayUnit(biomarker.definition), biomarker.reference ?? biomarker.definition.reference)}
        </span>
        <span className="text-muted-foreground">
          {formatReference(biomarker.reference ?? biomarker.definition.reference)}
        </span>
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
          <ExpandedBiomarkerDetails
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

function MergedSectionHeader({ source }: { source: MergedSource | null }) {
  const title = source?.title?.trim() || 'Merged readings'
  const time = source?.time?.trim()
  const meta = [source?.clinic?.trim(), source?.provider?.trim()]
    .filter((v): v is string => !!v)
    .join(' · ')
  return (
    <div className="border-b border-border bg-primary/5 px-4 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
        {title}
        {time ? ` \u00b7 ${time}` : ''}
      </p>
      {meta && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {meta}
        </p>
      )}
      <p className="mt-0.5 text-[10px] text-muted-foreground/70">
        Added from a later upload on the same date
      </p>
    </div>
  )
}
