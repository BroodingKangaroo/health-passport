'use client'

import { useState, useMemo, useRef, useEffect, useCallback, useId } from 'react'
import type { ComponentType } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  SlidersHorizontal,
  Paperclip,
  Search,
  X,
  RotateCcw,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
} from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { TYPE_VISUALS } from '@/lib/event-visuals'
import { Badge } from '@/components/ui/badge'
import { hasFlagged, statusCountsByEvent, type StatusCounts } from '@/lib/event-status'
import type { MedicalEvent, EventType, BiomarkerResult } from '@/lib/types'

const ALL_TYPES: EventType[] = ['blood_test', 'doctor_visit', 'instrumental_test', 'procedure']

interface HistoryListProps {
  events: MedicalEvent[]
  selectedId: string
  onSelect: (id: string) => void
  biomarkers?: BiomarkerResult[]
}

export function HistoryList({ events, selectedId, onSelect, biomarkers }: HistoryListProps) {
  const t = useTranslations('timeline.historyList')
  const locale = useLocale()
  const [showFilter, setShowFilter] = useState(false)
  const [search, setSearch] = useState('')
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest')
  const [typeFilters, setTypeFilters] = useState<EventType[]>(ALL_TYPES)
  const [abnormalOnly, setAbnormalOnly] = useState(false)
  const [attachmentsOnly, setAttachmentsOnly] = useState(false)

  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const chipsRef = useRef<HTMLDivElement>(null)
  const [chipOverflow, setChipOverflow] = useState({ left: false, right: false })

  // The nowrap chip row scrolls horizontally instead of wrapping (rail/
  // details alignment depends on its fixed height) — edge fades are the
  // scroll affordance, since a 28px-tall scroller shows no visible
  // scrollbar (macOS overlay scrollbars).
  const updateChipOverflow = useCallback(() => {
    const el = chipsRef.current
    if (!el) return
    setChipOverflow({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    })
  }, [])

  useEffect(() => {
    updateChipOverflow()
    const el = chipsRef.current
    if (!el) return
    el.addEventListener('scroll', updateChipOverflow, { passive: true })
    // Overflow also changes when the aside column resizes (window resize,
    // locale switch, filter changes re-rendering chips).
    window.addEventListener('resize', updateChipOverflow)
    return () => {
      el.removeEventListener('scroll', updateChipOverflow)
      window.removeEventListener('resize', updateChipOverflow)
    }
  }, [updateChipOverflow, events, locale])

  const activeFilterCount =
    (search ? 1 : 0) +
    (sortOrder !== 'newest' ? 1 : 0) +
    (typeFilters.length < ALL_TYPES.length ? 1 : 0) +
    (abnormalOnly ? 1 : 0) +
    (attachmentsOnly ? 1 : 0)

  useEffect(() => {
    if (!showFilter) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowFilter(false)
    }
    function onClickOutside(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setShowFilter(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onClickOutside)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onClickOutside)
    }
  }, [showFilter])

  const resetFilters = useCallback(() => {
    setSearch('')
    setSortOrder('newest')
    setTypeFilters(ALL_TYPES)
    setAbnormalOnly(false)
    setAttachmentsOnly(false)
  }, [])

  const toggleType = useCallback((t: EventType) => {
    setTypeFilters((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    )
  }, [])

  // Per-event flagged counts, computed once; the abnormal-only filter and
  // the card chips both read this map, so they cannot drift.
  const statusCounts = useMemo(
    () => statusCountsByEvent(biomarkers ?? [], events.map((e) => e.id)),
    [events, biomarkers],
  )

  const filteredEvents = useMemo(() => {
    let result = [...events]

    if (typeFilters.length < ALL_TYPES.length) {
      result = result.filter((e) => typeFilters.includes(e.type))
    }

    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          (e.subtitle && e.subtitle.toLowerCase().includes(q)) ||
          e.clinic.toLowerCase().includes(q),
      )
    }

    if (abnormalOnly) {
      result = result.filter(
        (e) => e.type === 'blood_test' && hasFlagged(statusCounts.get(e.id)),
      )
    }

    if (attachmentsOnly) {
      result = result.filter((e) => (e.attachments?.length ?? 0) > 0)
    }

    result.sort((a, b) => {
      const da = new Date(a.date).getTime()
      const db = new Date(b.date).getTime()
      return sortOrder === 'newest' ? db - da : da - db
    })

    return result
  }, [events, typeFilters, search, abnormalOnly, attachmentsOnly, sortOrder, statusCounts])

  // Bottom fade on the rail: same scroll-state-aware affordance as the
  // horizontal fades — shown only while rows remain below the fold (never
  // in the empty state or when scrolled to the very bottom).
  const railRef = useRef<HTMLDivElement>(null)
  const [bottomFade, setBottomFade] = useState(false)
  const updateRailFade = useCallback(() => {
    const el = railRef.current
    if (!el) return
    setBottomFade(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
  }, [])

  useEffect(() => {
    updateRailFade()
    const el = railRef.current
    if (!el) return
    el.addEventListener('scroll', updateRailFade, { passive: true })
    window.addEventListener('resize', updateRailFade)
    return () => {
      el.removeEventListener('scroll', updateRailFade)
      window.removeEventListener('resize', updateRailFade)
    }
    // The rail's content is filteredEvents (transitively events + biomarkers
    // via statusCounts); locale switches reformat the card text.
  }, [updateRailFade, filteredEvents, locale])

  // Per-type counts over ALL events — the chips double as the visual legend,
  // so the counts must not shift while filtering.
  const typeCounts = useMemo(() => {
    const counts = {} as Record<EventType, number>
    for (const type of ALL_TYPES) counts[type] = 0
    for (const e of events) {
      if (counts[e.type] !== undefined) counts[e.type] += 1
    }
    return counts
  }, [events])

  // Month markers on the rail: an on-line label overlay on the FIRST card of
  // each month-run in DISPLAY order — each event is compared with the
  // previous one, so sort/filter changes re-derive the markers naturally.
  // Invalid dates collapse to an 'invalid' key so they neither start nor
  // join a run.
  const monthStarts = useMemo(() => {
    const starts = new Set<number>()
    let prevKey: string | null = null
    filteredEvents.forEach((e, i) => {
      const d = new Date(e.date)
      const key = Number.isNaN(d.getTime()) ? 'invalid' : `${d.getFullYear()}-${d.getMonth()}`
      if (i === 0 || key !== prevKey) starts.add(i)
      prevKey = key
    })
    return starts
  }, [filteredEvents])

  // Month numbers shared by ≥2 distinct years in the visible list — those
  // groups' labels gain a 2-digit year line under the month ("Jun" / «'26»).
  const crossYearMonths = useMemo(() => {
    const yearsByMonth = new Map<number, Set<number>>()
    for (const e of filteredEvents) {
      const d = new Date(e.date)
      if (Number.isNaN(d.getTime())) continue
      const years = yearsByMonth.get(d.getMonth()) ?? new Set<number>()
      years.add(d.getFullYear())
      yearsByMonth.set(d.getMonth(), years)
    }
    const collisions = new Set<number>()
    for (const [month, years] of yearsByMonth) {
      if (years.size > 1) collisions.add(month)
    }
    return collisions
  }, [filteredEvents])

  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short' }), [locale])
  const yearFmt = useMemo(() => new Intl.DateTimeFormat(locale, { year: '2-digit' }), [locale])

  // Empty state borrows the single remaining type's visual family when the
  // emptiness is caused by type filtering alone (no search / quick filters).
  const emptySingleType =
    !search && !abnormalOnly && !attachmentsOnly && typeFilters.length === 1
      ? typeFilters[0]
      : null

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-3">
      {/* sr-only: the visible History heading was dropped — the chips row +
          filter button form the pane's single settings row (28px, same as
          the details tab strip), lifting both panes' content up (§5.5). */}
      <h2 id={headingId} className="sr-only">{t('title')}</h2>
      {/* Type filter chips + the filter button: the pane's single settings
          row. The chips are the legend for the type colors (dot), a one-tap
          filter, and the per-type counts. Color never signals state: the dot
          stays type-colored whether the chip is on or off. Zero-count types
          stay rendered (the chips double as the type legend) but are DISABLED
          — dimmed, aria-disabled, non-interactive — since filtering to an
          empty type is a no-op. The row never wraps: nowrap + horizontal
          scroll overflow keeps the chips a fixed height (h-7, the details
          tab strip's height), so both panes share a 28px settings row + 12px
          gap and the rail's top edge matches the details' first content row.
          Compact short labels (chip* keys) keep the chips small. The chips
          start at the cards' pl (pl-5 sm:pl-7), so the left 20/28px channel
          stays empty from the block top down — the calendar line's channel. */}
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="relative min-w-0 flex-1">
          {chipOverflow.left && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-background to-transparent"
            />
          )}
          {chipOverflow.right && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 z-10 w-5 bg-gradient-to-l from-background to-transparent"
            />
          )}
          <div
            ref={chipsRef}
            className="scrollbar-none flex h-7 flex-nowrap gap-1 overflow-x-auto pl-5 sm:pl-7"
            role="group"
            aria-label={t('entryType')}
          >
          <button
            onClick={() => setTypeFilters(ALL_TYPES)}
            aria-pressed={typeFilters.length === ALL_TYPES.length}
            className={cn(
              'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
              typeFilters.length === ALL_TYPES.length
                ? 'border border-border bg-card text-foreground'
                : 'bg-muted/60 text-muted-foreground hover:text-foreground',
            )}
          >
            {t('filterAll')}
            <span className="text-muted-foreground/70">{events.length}</span>
          </button>
          {ALL_TYPES.map((type) => {
            const visual = TYPE_VISUALS[type]
            const active = typeFilters.includes(type)
            const empty = typeCounts[type] === 0
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                aria-pressed={active}
                aria-disabled={empty || undefined}
                title={empty ? t('noRecordsOfType') : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
                  empty && 'cursor-not-allowed opacity-40',
                  !empty && !active && 'hover:text-foreground',
                  active
                    ? 'border border-border bg-card text-foreground'
                    : 'bg-muted/60 text-muted-foreground',
                )}
              >
                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', visual.dotClass)} />
                {t(visual.chipLabelKey)}
                <span className="text-muted-foreground/70">{typeCounts[type]}</span>
              </button>
            )
          })}
          </div>
        </div>
        <div className="relative">
          <button
            ref={buttonRef}
            aria-label={t('filterAria')}
            onClick={() => setShowFilter((v) => !v)}
            className={cn(
              'relative flex size-7 items-center justify-center rounded-md transition-colors',
              showFilter
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <SlidersHorizontal className="size-4" />
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </button>

          {showFilter && (
            <div
              ref={popoverRef}
              className="absolute right-0 top-full z-50 mt-2 max-h-[min(32rem,calc(100dvh-7rem))] w-72 overflow-y-auto overscroll-contain rounded-xl border bg-card p-4 shadow-xl"
            >
              <div className="space-y-4">
                {/* Search */}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('searchPlaceholder')}
                    className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-8 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none"
                  />
                  {search && (
                    <button
                      onClick={() => setSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>

                {/* Sort */}
                <div>
                  <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <ArrowUpDown className="size-3" />
                    {t('sort')}
                  </label>
                  <div className="flex gap-2">
                    {(['newest', 'oldest'] as const).map((order) => (
                      <button
                        key={order}
                        onClick={() => setSortOrder(order)}
                        className={cn(
                          'flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                          sortOrder === order
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:border-primary/20 hover:text-foreground',
                        )}
                      >
                        {order === 'newest' ? t('newestFirst') : t('oldestFirst')}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Type filters */}
                <div>
                  <label className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('entryType')}
                  </label>
                  <div className="flex flex-col gap-1">
                    {ALL_TYPES.map((type) => {
                      const visual = TYPE_VISUALS[type]
                      const Icon = visual.icon
                      const active = typeFilters.includes(type)
                      return (
                        <button
                          key={type}
                          onClick={() => toggleType(type)}
                          className={cn(
                            'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm transition-colors',
                            active
                              ? 'text-foreground'
                              : 'text-muted-foreground/50 line-through',
                          )}
                        >
                          <div
                            className={cn(
                              'flex size-4 items-center justify-center rounded border transition-colors',
                              active
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border',
                            )}
                          >
                            {active && (
                              <svg className="size-3" viewBox="0 0 12 12" fill="none">
                                <path
                                  d="M2.5 6l2.5 2.5 4.5-5"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </div>
                          <Icon className="size-4" />
                          {t(visual.labelKey)}
                          <span className="ml-auto text-xs text-muted-foreground/60">
                            {typeCounts[type]}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Quick toggles */}
                <div>
                  <label className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('quickFilters')}
                  </label>
                  <div className="flex flex-col gap-1">
                    <ToggleRow
                      icon={AlertTriangle}
                      label={t('abnormalResults')}
                      description={t('abnormalResultsDesc')}
                      active={abnormalOnly}
                      onToggle={() => setAbnormalOnly((v) => !v)}
                    />
                    <ToggleRow
                      icon={Paperclip}
                      label={t('hasAttachments')}
                      description={t('hasAttachmentsDesc')}
                      active={attachmentsOnly}
                      onToggle={() => setAttachmentsOnly((v) => !v)}
                    />
                  </div>
                </div>

                {/* Reset */}
                {activeFilterCount > 0 && (
                  <button
                    onClick={resetFilters}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                  >
                    <RotateCcw className="size-3" />
                    {t('resetFilters')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Spine extension to the block top: bridges the chips row + gap
          (h-10 = 28px + 12px) so the calendar line starts at the pane top
          and meets the first row's top-0 segment. Root-relative x 10/11.5 =
          the rows' spine page-x (row-x 6/7.5 + the rows container's 4px
          clearance). Hidden in the empty state (no rows to connect to);
          z-10 keeps it above the chips' edge fades. */}
      {filteredEvents.length > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-[10px] top-0 z-10 h-10 w-px -translate-x-1/2 bg-border sm:left-[11.5px]"
        />
      )}
      {/* Bottom fade: only while rows remain below the fold (scroll-state
          aware, like the chips row's horizontal fades). Anchored to the root
          — the rail is its last flex child, so the root's bottom edge is the
          rail's bottom edge. z-20 paints over the rail's z-10 nodes, so dots
          dim with the cards/spine at the bottom edge. */}
      {bottomFade && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-6 bg-gradient-to-t from-background to-transparent"
        />
      )}
      {/* Chronology rail: a quiet hairline spine with a type-colored node
          per event. The node carries the type channel only; selection is the
          primary accent (ring), never a type color. No icons inside nodes —
          the card bubble already carries the icon. The spine is drawn as
          per-row half-segments (top segment from the row's top edge on the
          first row, from 8px into the gap on later rows; bottom segment to
          the row's bottom edge on every non-last row) so each inter-row gap
          is covered EXACTLY ONCE by the next row's top stub — no alpha
          stacking (dark --border is 10%-alpha, overlapping layers read as
          brighter patches) — and the spine starts/ends exactly at the
          first/last node, never rendering in the empty state. Month markers
          are zero-height overlays on the first card row of each month-run,
          sitting just right of the spine (no background — the line reads
          continuous; long months' ink may soft-cross the card edge); they
          shift no layout, so the first card starts at the scroller's content
          top. */}
      <div
        ref={railRef}
        role="region"
        aria-labelledby={headingId}
        tabIndex={0}
        className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1"
      >
        {/* pl-1/pr-1: 4px clip clearance both sides — the selected node's
            ring-offset+ring extends 4px left of the node, and card focus
            outlines need room on the right; without it the scroller's clip
            edge (the scroller has no horizontal padding) cuts the ring into
            a "C". Cards stay at page-x 20/28 (4 + pl-4/sm:pl-6). */}
        <div className="flex flex-col gap-2 pl-1 pr-1">
          {filteredEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div
                className={cn(
                  'mb-2 flex size-9 items-center justify-center rounded-full',
                  emptySingleType
                    ? TYPE_VISUALS[emptySingleType].bubbleClass
                    : 'bg-muted text-muted-foreground/40',
                )}
              >
                {emptySingleType ? (
                  (() => {
                    const EmptyIcon = TYPE_VISUALS[emptySingleType].icon
                    return <EmptyIcon className="size-4" />
                  })()
                ) : (
                  <Search className="size-4" />
                )}
              </div>
              <p className="text-sm font-medium text-muted-foreground">
                {t('noMatching')}
              </p>
              {activeFilterCount > 0 && (
                <button
                  onClick={resetFilters}
                  className="mt-2 text-xs text-primary hover:underline"
                >
                  {t('resetFilters')}
                </button>
              )}
            </div>
          ) : (
            filteredEvents.map((event, idx) => {
              const active = event.id === selectedId
              const visual = TYPE_VISUALS[event.type]
              const Icon = visual.icon
              const count = event.attachments?.length ?? 0
              const eventCounts = statusCounts.get(event.id)
              const isFirst = idx === 0
              const isLast = idx === filteredEvents.length - 1
              const d = new Date(event.date)
              const showMonth = monthStarts.has(idx) && !Number.isNaN(d.getTime())
              return (
                <div key={event.id} className="relative flex items-center pl-4 sm:pl-6">
                  {/* Node center: page-x 10px mobile / 11.5px sm (row-x 6/7.5
                      + the rows container's 4px clearance) — the spine
                      half-segments below align to the same x, and the node's
                      left edge sits at page-x 4 so the ring's 4px left arc is
                      unclipped. */}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute bottom-1/2 left-[6px] w-px -translate-x-1/2 bg-border sm:left-[7.5px]',
                      isFirst ? 'top-0' : '-top-2',
                    )}
                  />
                  {!isLast && (
                    <span
                      aria-hidden
                      className="absolute bottom-0 left-[6px] top-1/2 w-px -translate-x-1/2 bg-border sm:left-[7.5px]"
                    />
                  )}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute left-0 z-10 size-3 rounded-full border-2 border-background sm:size-[15px]',
                      visual.nodeClass,
                      active && 'ring-2 ring-primary/40 ring-offset-2 ring-offset-background',
                    )}
                  />
                  {/* On-line month marker: zero-height overlay sitting just
                      RIGHT of the spine line (row-x 7.5/9 = line + ~1.5px) —
                      no background, so the line stays continuous behind it
                      and nothing notches the card's corner; long months'
                      glyph ink may soft-cross the card edge (no truncation).
                      Year goes on a second line — inline "Jun '26" never
                      fits the 20/28px gutter.
                      Z-order guard: node and label are both z-10 and tree
                      order decides (label later → on top if they ever met);
                      safe at current card sizes (2-line label ≈20px vs node
                      top ≈29px on the shortest cards, ring top ≈25px) —
                      revisit if cards get more compact. */}
                  {showMonth && (
                    <span
                      className="absolute left-[7.5px] top-0 z-10 flex flex-col items-start"
                    >
                      <span
                        className={cn(
                          'whitespace-nowrap text-[10px] font-medium uppercase leading-none tracking-wider text-muted-foreground/60',
                        )}
                      >
                        {monthFmt.format(d)}
                      </span>
                      {crossYearMonths.has(d.getMonth()) && (
                        <span className="whitespace-nowrap text-[10px] font-medium uppercase leading-none tracking-wider text-muted-foreground/60">
                          {`'${yearFmt.format(d)}`}
                        </span>
                      )}
                    </span>
                  )}
                  <button
                    onClick={() => onSelect(event.id)}
                    className={cn(
                      // min-w-0 is critical: as a row flex item the button's
                      // automatic minimum size would otherwise be the
                      // truncated title's full nowrap width, blowing the card
                      // out of the sidebar column (and over the detail panel).
                      'flex min-w-0 flex-1 items-center gap-3 rounded-xl border p-3 text-left transition-all',
                      active
                        ? 'border-primary/30 bg-accent shadow-sm'
                        : 'border-border bg-card hover:border-primary/20 hover:bg-accent/40',
                    )}
                  >
                    <div
                      className={cn(
                        'flex size-9 shrink-0 items-center justify-center rounded-full',
                        visual.bubbleClass,
                      )}
                    >
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1 leading-tight">
                      {/* Wraps to two lines instead of ellipsizing: long
                          visit/lab titles stay readable; the full title
                          remains reachable via the tooltip. */}
                      <p
                        className="line-clamp-2 text-sm font-semibold text-foreground"
                        title={event.title}
                      >
                        {event.title}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDate(event.date, locale)}</p>
                      {/* Signal cluster (bottom-right corner): the flagged
                          status pills and the attachment count as one
                          right-aligned pill row, so they read as a single
                          aligned block on every card regardless of title
                          wrapping. Status pills come first (priority
                          signal); the clinic line truncates before the
                          cluster ever shrinks. */}
                      <div className="flex items-center gap-2">
                        <p
                          className="min-w-0 flex-1 truncate text-xs text-muted-foreground/80"
                          title={event.clinic}
                        >
                          {event.clinic}
                        </p>
                        {((event.type === 'blood_test' && hasFlagged(eventCounts)) || count > 0) && (
                          <span className="flex shrink-0 items-center gap-1">
                            {event.type === 'blood_test' && eventCounts && hasFlagged(eventCounts) && (
                              <StatusSummaryChips counts={eventCounts} />
                            )}
                            {count > 0 && (
                              <Badge variant="chip" className="px-1.5">
                                <Paperclip className="size-3" />
                                {count}
                              </Badge>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

function StatusSummaryChips({ counts }: { counts: StatusCounts }) {
  const t = useTranslations('timeline.historyList')
  const details = [
    counts.high > 0 ? t('flaggedHigh', { count: counts.high }) : '',
    counts.low > 0 ? t('flaggedLow', { count: counts.low }) : '',
    counts.abnormal > 0 ? t('flaggedAbnormal', { count: counts.abnormal }) : '',
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <>
      <span aria-hidden className="flex shrink-0 items-center gap-1">
        {counts.high > 0 && (
          <Badge variant="chip" className="px-1.5" title={t('flaggedHigh', { count: counts.high })}>
            <ArrowUp className="size-3 text-status-high" />
            {counts.high}
          </Badge>
        )}
        {counts.low > 0 && (
          <Badge variant="chip" className="px-1.5" title={t('flaggedLow', { count: counts.low })}>
            <ArrowDown className="size-3 text-status-low" />
            {counts.low}
          </Badge>
        )}
        {counts.abnormal > 0 && (
          <Badge variant="chip" className="px-1.5" title={t('flaggedAbnormal', { count: counts.abnormal })}>
            <AlertTriangle className="size-3 text-status-high" />
            {counts.abnormal}
          </Badge>
        )}
      </span>
      <span className="sr-only">{t('flaggedSummary', { details })}</span>
    </>
  )
}

function ToggleRow({
  icon: Icon,
  label,
  description,
  active,
  onToggle,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  description: string
  active: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
        active ? 'bg-primary/5' : 'hover:bg-muted/50',
      )}
    >
      <Icon className={cn('size-4', active ? 'text-primary' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div
        className={cn(
          'flex h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors',
          active ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <div
          className={cn(
            'h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
            active ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </div>
    </button>
  )
}
