'use client'

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import type { ComponentType } from 'react'
import {
  SlidersHorizontal,
  Droplet,
  Stethoscope,
  Brain,
  Syringe,
  Paperclip,
  Search,
  X,
  RotateCcw,
  ArrowUpDown,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MedicalEvent, EventType, BiomarkerResult } from '@/lib/types'

const iconMap: Record<EventType, ComponentType<{ className?: string }>> = {
  blood_test: Droplet,
  doctor_visit: Stethoscope,
  imaging: Brain,
  procedure: Syringe,
}

const typeLabels: Record<EventType, string> = {
  blood_test: 'Blood Tests',
  doctor_visit: 'Doctor Visits',
  imaging: 'Imaging',
  procedure: 'Procedures',
}

const ALL_TYPES: EventType[] = ['blood_test', 'doctor_visit', 'imaging', 'procedure']

interface HistoryListProps {
  events: MedicalEvent[]
  selectedId: string
  onSelect: (id: string) => void
  biomarkers?: BiomarkerResult[]
}

export function HistoryList({ events, selectedId, onSelect, biomarkers }: HistoryListProps) {
  const [showFilter, setShowFilter] = useState(false)
  const [search, setSearch] = useState('')
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest')
  const [typeFilters, setTypeFilters] = useState<EventType[]>(ALL_TYPES)
  const [abnormalOnly, setAbnormalOnly] = useState(false)
  const [attachmentsOnly, setAttachmentsOnly] = useState(false)

  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

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
            { date: b.date, value: b.value, status: b.status },
          ]
          const match = all.find((r) => r.date === e.date)
          return match && (match.status === 'high' || match.status === 'low')
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-foreground">History</h2>
        <div className="relative">
          <button
            ref={buttonRef}
            aria-label="Filter history"
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
              <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-status-high text-[9px] font-bold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>

          {showFilter && (
            <div
              ref={popoverRef}
              className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border bg-card p-4 shadow-xl"
            >
              <div className="space-y-4">
                {/* Search */}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by title, doctor, clinic..."
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
                    Sort
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
                        {order === 'newest' ? 'Newest First' : 'Oldest First'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Type filters */}
                <div>
                  <label className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Entry Type
                  </label>
                  <div className="flex flex-col gap-1">
                    {ALL_TYPES.map((t) => {
                      const Icon = iconMap[t]
                      const active = typeFilters.includes(t)
                      return (
                        <button
                          key={t}
                          onClick={() => toggleType(t)}
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
                          {typeLabels[t]}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Quick toggles */}
                <div>
                  <label className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Quick Filters
                  </label>
                  <div className="flex flex-col gap-1">
                    <ToggleRow
                      icon={AlertTriangle}
                      label="Abnormal Results"
                      description="Only lab tests with flagged values"
                      active={abnormalOnly}
                      onToggle={() => setAbnormalOnly((v) => !v)}
                    />
                    <ToggleRow
                      icon={Paperclip}
                      label="Has Attachments"
                      description="Only entries with source documents"
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
                    Reset all filters
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Search className="mb-2 size-8 text-muted-foreground/40" />
            <p className="text-sm font-medium text-muted-foreground">
              No matching records found
            </p>
            {activeFilterCount > 0 && (
              <button
                onClick={resetFilters}
                className="mt-2 text-xs text-primary hover:underline"
              >
                Reset all filters
              </button>
            )}
          </div>
        ) : (
          filteredEvents.map((event) => {
            const active = event.id === selectedId
            const Icon = iconMap[event.type]
            const count = event.attachments?.length ?? 0
            return (
              <button
                key={event.id}
                onClick={() => onSelect(event.id)}
                className={cn(
                  'flex items-center gap-3 rounded-xl border p-3 text-left transition-all',
                  active
                    ? 'border-primary/30 bg-accent shadow-sm'
                    : 'border-border bg-card hover:border-primary/20 hover:bg-accent/40',
                )}
              >
                <div
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-full',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-primary',
                  )}
                >
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0 leading-tight">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {event.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{event.date}</p>
                  <p className="text-xs text-muted-foreground/80">{event.clinic}</p>
                </div>
                {count > 0 && (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-sm text-muted-foreground/50">
                    <Paperclip className="size-4" />
                    {count}
                  </span>
                )}
              </button>
            )
          })
        )}
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
