'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Search,
  ChevronDown,
  ChevronUp,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
} from 'lucide-react'

import { cn, formatDate, formatNumber } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { StatusBadge } from '@/components/shared/StatusBadge'
import {
  formatReference,
  intervalBounds,
  unitLabel,
  displayUnit,
} from '@/lib/reference'
import { ExpandedBiomarkerDetails } from './expanded-biomarker-details'
import type { BiomarkerResult, MergedSource, Status } from '@/lib/types'

const GRID_COLS =
  'grid grid-cols-[1.5fr_1.5fr_1fr_1fr_1.3fr_1.2fr_40px] items-center gap-x-3'

type SortCol = 'name' | 'original' | 'value' | 'unit' | 'reference' | 'status'
type SortDir = 'asc' | 'desc'
interface SortState {
  col: SortCol
  dir: SortDir
}

/** Clinical severity: ascending shows calmest first, descending flags first. */
const STATUS_RANK: Record<Status, number> = {
  normal: 0,
  low: 1,
  high: 2,
  abnormal: 3,
}

// Missing-value buckets: 0 = primary content, 1 = text values (qualitative
// readings / references), 2 = absent. Group 2 always sorts last — in BOTH
// directions — so flipping asc/desc never floats empties to the top.
const GROUP_PRIMARY = 0
const GROUP_TEXT = 1
const GROUP_MISSING = 2

function unitKeyOf(b: BiomarkerResult): string {
  return unitLabel(
    displayUnit(b.definition),
    b.reference ?? b.definition.reference,
  )
}

function makeCmp(
  col: SortCol,
  dir: SortDir,
  collator: Intl.Collator,
): (a: BiomarkerResult, b: BiomarkerResult) => number {
  const groupOf = (b: BiomarkerResult): number => {
    switch (col) {
      case 'value': {
        const v = b.value
        if (v == null || v === '') return GROUP_MISSING
        return typeof v === 'number' ? GROUP_PRIMARY : GROUP_TEXT
      }
      case 'unit':
        return unitKeyOf(b) ? GROUP_PRIMARY : GROUP_MISSING
      case 'reference': {
        const ref = b.reference ?? b.definition.reference
        if (!ref) return GROUP_MISSING
        if (ref.kind === 'interval') {
          const { low, high } = intervalBounds(ref) ?? { low: null, high: null }
          return low == null && high == null ? GROUP_MISSING : GROUP_PRIMARY
        }
        return ref.expected && ref.expected.trim() ? GROUP_TEXT : GROUP_MISSING
      }
      default:
        return GROUP_PRIMARY
    }
  }

  const withinGroup = (a: BiomarkerResult, b: BiomarkerResult): number => {
    switch (col) {
      case 'name':
        return collator.compare(a.definition.names.en, b.definition.names.en)
      case 'original':
        return collator.compare(
          a.original_name || a.definition.names.ru,
          b.original_name || b.definition.names.ru,
        )
      case 'value': {
        const av = a.value
        const bv = b.value
        if (typeof av === 'number' && typeof bv === 'number') return av - bv
        return collator.compare(String(av), String(bv))
      }
      case 'unit':
        return collator.compare(unitKeyOf(a), unitKeyOf(b))
      case 'reference': {
        const ra = a.reference ?? a.definition.reference
        const rb = b.reference ?? b.definition.reference
        if (ra && rb && ra.kind === 'interval' && rb.kind === 'interval') {
          const ia = intervalBounds(ra) ?? { low: null, high: null }
          const ib = intervalBounds(rb) ?? { low: null, high: null }
          const lowA = ia.low ?? -Infinity
          const lowB = ib.low ?? -Infinity
          if (lowA !== lowB) return lowA - lowB
          return (ia.high ?? Infinity) - (ib.high ?? Infinity)
        }
        const ea = ra && ra.kind === 'qualitative' ? (ra.expected ?? '') : ''
        const eb = rb && rb.kind === 'qualitative' ? (rb.expected ?? '') : ''
        return collator.compare(ea, eb)
      }
      case 'status':
        return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    }
  }

  return (a, b) => {
    const g = groupOf(a) - groupOf(b)
    if (g !== 0) return g
    const r = withinGroup(a, b)
    if (r !== 0) return dir === 'asc' ? r : -r
    // Stable tie-breaker independent of direction.
    return collator.compare(a.definition.names.en, b.definition.names.en)
  }
}

const NO_SORT: SortState | null = null

export function ResultsPanel({
  biomarkers,
  labName,
  date,
  entryId,
  onViewDetails,
}: {
  biomarkers: BiomarkerResult[]
  labName: string
  date: string
  // Entry (medical event) this panel displays — keys the per-entry sort
  // memory: switching entries resets to document order, returning to an
  // entry restores the sort its user left behind.
  entryId?: string
  onViewDetails?: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortsByEntry, setSortsByEntry] = useState<Record<string, SortState | null>>({})
  const t = useTranslations('timeline.resultsPanel')
  const locale = useLocale()

  const sortKey = entryId ?? '_default'
  const sort = sortsByEntry[sortKey] ?? NO_SORT

  const cycleSort = (col: SortCol) => {
    setSortsByEntry((prev) => {
      const cur = prev[sortKey] ?? NO_SORT
      const next: SortState | null =
        !cur || cur.col !== col
          ? { col, dir: 'asc' }
          : cur.dir === 'asc'
            ? { col, dir: 'desc' }
            : NO_SORT
      return { ...prev, [sortKey]: next }
    })
  }

  const collator = useMemo(
    () => new Intl.Collator(locale, { sensitivity: 'base', numeric: true }),
    [locale],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return biomarkers
    return biomarkers.filter(
      (b) =>
        b.definition.names.en.toLowerCase().includes(q) ||
        b.definition.names.ru.toLowerCase().includes(q),
    )
  }, [query, biomarkers])

  // Sorting happens after filtering and before the original/merged split,
  // so rows sort within each section while the section headers themselves
  // (and the order of the merged groups) stay in document order.
  const sorted = useMemo(() => {
    if (!sort) return filtered
    const cmp = makeCmp(sort.col, sort.dir, collator)
    return [...filtered].sort(cmp)
  }, [filtered, sort, collator])

  // Original readings first, then merged-in ones grouped by the upload that
  // contributed them (same title/clinic/provider/time = same group). A merged
  // entry's biomarkers are either original-only or merged-only (the merge
  // conflict check forbids duplicates), so the split is unambiguous.
  const { originalList, mergedGroups } = useMemo(() => {
    const originals: BiomarkerResult[] = []
    const groups = new Map<string, { source: MergedSource | null; rows: BiomarkerResult[] }>()
    for (const b of sorted) {
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
  }, [sorted])

  return (
    <Card className="overflow-hidden border-border">
      <div className="flex flex-nowrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0 leading-tight">
          <h2 className="text-base font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="truncate text-xs text-muted-foreground" title={`${formatDate(date, locale)} · ${labName}`}>
            {formatDate(date, locale)} · {labName}
          </p>
        </div>
        <div className="relative shrink-0 sm:w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[768px]">
          <div
            className={cn(
              GRID_COLS,
              'border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
            )}
          >
            <SortHeaderCell col="name" label={t('colBiomarker')} sort={sort} onCycle={cycleSort} />
            <SortHeaderCell col="original" label={t('colOriginalName')} sort={sort} onCycle={cycleSort} />
            <SortHeaderCell col="value" label={t('colLatest')} sort={sort} onCycle={cycleSort} />
            <SortHeaderCell col="unit" label={t('colUnit')} sort={sort} onCycle={cycleSort} />
            <SortHeaderCell col="reference" label={t('colReference')} sort={sort} onCycle={cycleSort} />
            <SortHeaderCell col="status" label={t('colStatus')} sort={sort} onCycle={cycleSort} />
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
                ? t('emptySearch', { query })
                : t('empty')}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

function SortHeaderCell({
  col,
  label,
  sort,
  onCycle,
}: {
  col: SortCol
  label: string
  sort: SortState | null
  onCycle: (col: SortCol) => void
}) {
  const t = useTranslations('timeline.resultsPanel')
  const active = sort?.col === col
  const dir = active ? sort.dir : null
  return (
    <div
      className="group min-w-0"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        title={t('sortTooltip')}
        onClick={() => onCycle(col)}
        className={cn(
          'flex w-full min-w-0 items-center gap-1 text-left transition-colors',
          active ? 'text-foreground' : 'hover:text-foreground',
        )}
      >
        <span className="min-w-0">{label}</span>
        {active && dir === 'asc' && (
          <ArrowUp className="size-3 shrink-0 text-primary" aria-hidden />
        )}
        {active && dir === 'desc' && (
          <ArrowDown className="size-3 shrink-0 text-primary" aria-hidden />
        )}
        {!active && (
          <ArrowUpDown
            className="size-3 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-hidden
          />
        )}
      </button>
    </div>
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
  const t = useTranslations('timeline.resultsPanel')
  const title = source?.title?.trim() || t('mergedFallbackTitle')
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
        {t('mergedSubtitle')}
      </p>
    </div>
  )
}
