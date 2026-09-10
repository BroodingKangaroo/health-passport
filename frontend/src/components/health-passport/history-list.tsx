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
  AlertTriangle,
} from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { TYPE_VISUALS } from '@/lib/event-visuals'
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
  // scroll affordance, since a 22px-tall scroller shows no visible
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
      result = result.filter((e) => {
        if (e.type !== 'blood_test') return false
        if (!biomarkers) return false
        return biomarkers.some((b) => {
          const all = [
            ...(b.history ?? []),
            { entry_id: b.entry_id, date: b.date, value: b.value, status: b.status },
          ]
          const match = all.find((r) => r.entry_id === e.id)
          return match && (match.status === 'high' || match.status === 'low' || match.status === 'abnormal')
        })
      })
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
  }, [events, typeFilters, search, abnormalOnly, attachmentsOnly, sortOrder, biomarkers])

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

  // Empty state borrows the single remaining type's visual family when the
  // emptiness is caused by type filtering alone (no search / quick filters).
  const emptySingleType =
    !search && !abnormalOnly && !attachmentsOnly && typeFilters.length === 1
      ? typeFilters[0]
      : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">{t('title')}</h2>
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

      {/* Type filter chips — the legend for the type colors (dot), a one-tap
          filter, and the per-type counts. Color never signals state: the dot
          stays type-colored whether the chip is on or off. Zero-count types
          stay rendered (the chips double as the type legend) but are DISABLED
          — dimmed, aria-disabled, non-interactive — since filtering to an
          empty type is a no-op. The row never wraps: nowrap + horizontal
          scroll overflow keeps the chip row a fixed height, which pins the
          chronology rail's top edge to the details panel's top edge
          (the wrapped row was the rail/details misalignment). Compact short
          labels (chip* keys) keep the chips small. */}
      <div className="relative shrink-0">
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
          className="flex min-h-[22px] flex-nowrap gap-1 overflow-x-auto px-1"
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

      {/* Chronology rail: a quiet hairline spine with a type-colored node
          per event. The node carries the type channel only; selection is the
          primary accent (ring), never a type color. No icons inside nodes —
          the card bubble already carries the icon. The spine is drawn as
          per-row half-segments (top segment on every non-first row, bottom
          segment on every non-last row) so it starts and ends exactly at the
          first/last node and never renders in the empty state. Segments
          extend through the inter-row gap to stay continuous. */}
      <div
        role="region"
        aria-labelledby={headingId}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1"
      >
        <div className="flex flex-col gap-2">
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
              const isFirst = idx === 0
              const isLast = idx === filteredEvents.length - 1
              return (
                <div key={event.id} className="relative flex items-center pl-5 sm:pl-7">
                  {/* Node center: mobile x=6px (size-3), sm x=7.5px (15px) —
                      the spine half-segments below align to the same x. */}
                  {!isFirst && (
                    <span
                      aria-hidden
                      className="absolute -top-2 bottom-1/2 left-[6px] w-px -translate-x-1/2 bg-border sm:left-[7.5px]"
                    />
                  )}
                  {!isLast && (
                    <span
                      aria-hidden
                      className="absolute bottom-[-8px] left-[6px] top-1/2 w-px -translate-x-1/2 bg-border sm:left-[7.5px]"
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
                    <div className="min-w-0 leading-tight">
                      {/* Wraps to two lines instead of ellipsizing: long
                          visit/lab titles stay readable; the full title
                          remains reachable via the tooltip. */}
                      <p className="line-clamp-2 text-sm font-semibold text-foreground" title={event.title}>
                        {event.title}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDate(event.date, locale)}</p>
                      <p className="truncate text-xs text-muted-foreground/80" title={event.clinic}>{event.clinic}</p>
                    </div>
                    {count > 0 && (
                      <span className="ml-auto flex shrink-0 items-center gap-1 text-sm text-muted-foreground/50">
                        <Paperclip className="size-4" />
                        {count}
                      </span>
                    )}
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
