'use client'

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { NavBar } from '@/components/shared/NavBar'
import { LoadErrorState } from '@/components/shared/LoadErrorState'
import { ShareNotice } from '@/components/share/sender/share-notice'
import { HistoryList } from '@/components/health-passport/history-list'
import { DoctorVisitDetails } from '@/components/health-passport/doctor-visit-details'
import { BloodTestDetails } from '@/components/health-passport/blood-test-details'
import { InstrumentalTestDetails } from '@/components/health-passport/instrumental-test-details'
import { TYPE_VISUALS } from '@/lib/event-visuals'
import { cn, formatDate } from '@/lib/utils'
import { useTimelineData } from '@/hooks/useTimelineData'
import type { MedicalEvent, BiomarkerResult, Reading, TimelineResponse } from '@/lib/types'

export function TimelineView() {
  const router = useRouter()
  const { data, isLoading, error, refetch } = useTimelineData()
  const chromeRef = useRef<HTMLDivElement>(null)
  const [chromeH, setChromeH] = useState(0)

  // The mobile switcher (§5.7) pins below the sticky chrome; its height
  // changes when the header wraps (RU labels, zoom), so measure it instead of
  // hardcoding an offset. /demo does not use this wrapper and inherits the
  // `--chrome-h: 0px` default from globals.css.
  useLayoutEffect(() => {
    const el = chromeRef.current
    if (!el) return
    const measure = () => setChromeH(el.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      style={{ '--chrome-h': `${chromeH}px` } as CSSProperties}
      className="flex min-h-screen flex-col bg-background lg:h-screen lg:min-h-0 lg:overflow-hidden print:block print:h-auto print:min-h-0 print:overflow-visible"
    >
      <div ref={chromeRef} className="sticky top-0 z-40 lg:static print:static">
        <HeaderBar />
        <NavBar activeTab="timeline" />
      </div>
      {/* Quiet, self-hiding aside between the chrome and the two-pane shell:
          it only exists while an active link can see newer results. /demo
          renders TimelineContent directly, so the marketing surface never
          asks about links. */}
      <ShareNotice />
      <TimelineContent
        data={data}
        isLoading={isLoading}
        error={error}
        refetch={refetch}
        onViewDetails={(id) => router.push('/details?id=' + id + '&from=timeline')}
      />
    </div>
  )
}

interface TimelineContentProps {
  data: TimelineResponse | undefined
  isLoading: boolean
  error: Error | null
  refetch: () => void
  // Expand-row → full details navigation. Omitted on the /demo surface:
  // the fixture has no backing /api/biomarker payload, so the button is
  // hidden instead of navigating to an empty real-data view.
  onViewDetails?: (id: string) => void
}

/**
 * The timeline's presentational body (history list + detail views), split
 * from the data hook so the /demo marketing surface can render the exact
 * same components from fixture data.
 */
export function TimelineContent({
  data,
  isLoading,
  error,
  refetch,
  onViewDetails,
}: TimelineContentProps) {
  const t = useTranslations('timeline.views.timeline')
  const tc = useTranslations('common')
  const te = useTranslations('timeline.entrySettings')
  const locale = useLocale()
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)
  const detailsRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLElement>(null)

  const events: MedicalEvent[] = data?.events ?? []
  const biomarkers = useMemo(() => data?.biomarkers ?? [], [data?.biomarkers])
  const visits = data?.visits ?? {}
  const instrumental = data?.instrumental ?? {}
  // Default to the most recent event (events are date-ascending, so the last
  // element is newest) until the user picks one; never a stale hardcoded id.
  const effectiveSelected =
    selectedEvent ?? events[events.length - 1]?.id ?? events[0]?.id ?? ''
  const selectedEventData = events.find((e) => e.id === effectiveSelected)
  const ProcedureIcon = TYPE_VISUALS.procedure.icon

  const eventBiomarkers = useMemo(
    () => biomarkersAtDate(biomarkers, selectedEventData?.id ?? ''),
    [biomarkers, selectedEventData?.id],
  )

  // Card selection below lg: state first, then reveal the stacked details
  // pane in the next frame (after React commits) and move focus into it, so
  // keyboard users do not Tab onward from an off-screen card. Prev/next step
  // the pane in place and never scroll (the switcher is already on screen).
  const handleSelect = useCallback((id: string) => {
    setSelectedEvent(id)
    if (!isBelowLgViewport()) return
    requestAnimationFrame(() => {
      const el = detailsRef.current
      if (!el) return
      el.scrollIntoView({ block: 'start' })
      el.focus({ preventScroll: true })
    })
  }, [])

  const handleBackToHistory = useCallback(() => {
    const el = listRef.current
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    // Land on the rail region (the T1 keyboard affordance), not on a card.
    el.querySelector<HTMLElement>('[role="region"]')?.focus({ preventScroll: true })
  }, [])

  if (isLoading) {
    return (
      <main className="mx-auto max-w-[1800px] p-5 text-center text-sm text-muted-foreground">
        {tc('loading')}
      </main>
    )
  }

  if (error) {
    return (
      <main className="mx-auto max-w-[1800px] p-5 text-center">
        <LoadErrorState message={t('loadError')} onRetry={refetch} />
      </main>
    )
  }

  return (
    <main className="mx-auto grid w-full max-w-[1800px] flex-1 gap-5 p-5 lg:min-h-0 lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden lg:grid-cols-[minmax(288px,26%)_1fr] print:block print:h-auto print:overflow-visible">
      {/* min-w-0: grid items default to min-width:auto — without it a long
          unbreakable card title inflates the aside's intrinsic min-content
          and blows the column out below the lg breakpoint (the fixed
          minmax() track only protects >=lg). */}
      <aside
        ref={listRef}
        className="min-w-0 scroll-mt-[var(--chrome-h)] lg:min-h-0 print:h-auto"
      >
        <HistoryList
          events={events}
          selectedId={effectiveSelected}
          onSelect={handleSelect}
          biomarkers={biomarkers}
        />
      </aside>
      <section
        ref={detailsRef}
        tabIndex={-1}
        className="min-w-0 scroll-mt-[var(--chrome-h)] overflow-x-clip outline-none lg:min-h-0 lg:overflow-hidden print:h-auto print:overflow-visible [overflow-anchor:none]"
      >
        {/* `overflow-x-clip`, never `overflow-x-hidden`: hidden computes
            overflow-y to auto, which makes the section a scroll container and
            kills the switcher's position: sticky (verified in-browser).
            `overflow-anchor: none` keeps Chrome scroll anchoring from
            re-scrolling the document when prev/next swaps a short detail for
            a tall one — the documented contract is "step the pane in place,
            never scroll" (verified: 80→708px jump without it). */}
        <MobileEventSwitcher
          events={events}
          currentId={effectiveSelected}
          onSelect={setSelectedEvent}
          onBack={handleBackToHistory}
        />
        {selectedEventData?.type === 'doctor_visit' && visits[selectedEventData.id] ? (
          <DoctorVisitDetails
            visit={visits[selectedEventData.id]}
            entryId={selectedEventData.id}
            onDeleted={() => {
              setSelectedEvent(null)
              refetch()
            }}
          />
        ) : selectedEventData?.type === 'doctor_visit' ? (
          <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">
            <p>{t('visitDetailsUnavailable')}</p>
          </div>
        ) : selectedEventData?.type === 'blood_test' ? (
          <BloodTestDetails
            event={selectedEventData}
            biomarkers={eventBiomarkers}
            onViewDetails={onViewDetails}
            onDeleted={() => {
              setSelectedEvent(null)
              refetch()
            }}
          />
        ) : selectedEventData?.type === 'instrumental_test' && instrumental[selectedEventData.id] ? (
          <InstrumentalTestDetails
            event={selectedEventData}
            data={instrumental[selectedEventData.id]}
            onDeleted={() => {
              setSelectedEvent(null)
              refetch()
            }}
          />
        ) : selectedEventData?.type === 'instrumental_test' ? (
          <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">
            <p>{t('instrumentalDetailsUnavailable')}</p>
          </div>
        ) : selectedEventData?.type === 'procedure' ? (
          // Procedures have no dedicated detail view yet; render a minimal
          // summary card rather than a dead end (the /demo surface includes
          // a procedure event, so this stub is user-visible marketing).
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
                  TYPE_VISUALS.procedure.chipClass,
                )}
              >
                <ProcedureIcon className="size-3.5" />
                {te('typeProcedure')}
              </span>
              <span className="text-sm text-muted-foreground">
                {formatDate(selectedEventData.date, locale)}
              </span>
              <span className="truncate text-sm text-muted-foreground">
                {selectedEventData.clinic}
              </span>
            </div>
            <h2 className="mt-3 text-lg font-semibold text-foreground">
              {selectedEventData.title}
            </h2>
          </div>
        ) : selectedEventData ? (
          <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">
            <p>{t('noDetailView')}</p>
          </div>
        ) : null}
      </section>
    </main>
  )
}

/** Below the lg two-pane shell the list and details stack (§5.7). Mirrors
 * Tailwind v4's generated `lg` query (`min-width: 64rem`) instead of px so a
 * non-default browser default font size cannot decouple the layout from this
 * guard; jsdom (no matchMedia) stays on the static shell path in tests. */
function isBelowLgViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    !window.matchMedia('(min-width: 64rem)').matches
  )
}

interface MobileEventSwitcherProps {
  events: MedicalEvent[]
  currentId: string
  onSelect: (id: string) => void
  onBack: () => void
}

/**
 * Sticky master-detail switcher for the stacked (<lg) layout: back to the
 * history rail, position + title, older/newer steppers (§5.7). Hidden at lg+
 * and in print, and not rendered for a single event (no dead controls). It
 * walks the full ascending events array; filter-scoped stepping is deferred.
 */
function MobileEventSwitcher({ events, currentId, onSelect, onBack }: MobileEventSwitcherProps) {
  const t = useTranslations('timeline.views.timeline')
  const index = events.findIndex((e) => e.id === currentId)
  if (events.length < 2 || index === -1) return null
  const current = events[index]
  const stepButtonClass =
    'flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
  return (
    <div
      role="group"
      aria-label={t('eventNavigation')}
      className="sticky top-[var(--chrome-h)] z-30 mb-3 flex h-10 items-center gap-1 border-b border-border bg-background lg:hidden print:hidden"
    >
      <button
        type="button"
        onClick={onBack}
        aria-label={t('backToHistoryAria')}
        className="flex h-9 shrink-0 items-center gap-1 rounded-lg px-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t('backToHistory')}
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="sr-only">
          {t('eventPosition', { current: index + 1, total: events.length })}
        </span>
        <span aria-hidden className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {index + 1}/{events.length}
        </span>
        <span className="truncate text-sm font-semibold text-foreground" title={current.title}>
          {current.title}
        </span>
      </div>
      <button
        type="button"
        aria-label={t('previousEvent')}
        disabled={index <= 0}
        onClick={() => onSelect(events[index - 1].id)}
        className={stepButtonClass}
      >
        <ChevronLeft className="size-4" />
      </button>
      <button
        type="button"
        aria-label={t('nextEvent')}
        disabled={index >= events.length - 1}
        onClick={() => onSelect(events[index + 1].id)}
        className={stepButtonClass}
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
}

export function biomarkersAtDate(biomarkers: BiomarkerResult[], entryId: string): BiomarkerResult[] {
  if (!entryId) return biomarkers
  return biomarkers
    .map((b): BiomarkerResult | null => {
      const all: Reading[] = [
        ...(b.history ?? []),
        {
          entry_id: b.entry_id,
          date: b.date,
          value: b.value,
          status: b.status,
          // The top-level reading's scale/review flags (ISSUES.md #68) so the
          // selected event's chip renders its ScaleNote like the rest.
          scale_function: b.scale_function,
          needs_review: b.needs_review,
        },
      ]
      const idx = all.findIndex((r) => r.entry_id === entryId)
      if (idx === -1) return null
      const current = all[idx]
      const isLatest = idx === all.length - 1
      return {
        ...b,
        value: current.value,
        date: current.date,
        status: current.status,
        // The merged/merged_source flags must describe the reading AT this
        // event, not the latest reading of the definition: a biomarker merged
        // into an older entry and later re-tested separately is only "merged"
        // at the older event. History readings carry their own flags; the
        // latest reading's live on the top-level BiomarkerResult.
        merged: isLatest ? b.merged : current.merged,
        merged_source: isLatest ? b.merged_source : current.merged_source,
        // Same for the original-name/value/unit/range and the reference: an
        // older entry must show the metadata of the reading at THAT event,
        // not the newest doc's. History readings carry their own server-side
        // effective reference; the latest reading's live on the top-level
        // BiomarkerResult.
        original_name: isLatest ? b.original_name : current.original_name,
        original_value: isLatest ? b.original_value : current.original_value,
        original_unit: isLatest ? b.original_unit : current.original_unit,
        original_range: isLatest ? b.original_range : current.original_range,
        reference: isLatest ? b.reference : current.reference,
        // Same for the cross-scale conversion flags (ISSUES.md #68): the
        // selected event's chip must render its ScaleNote like every other
        // reading in the history list.
        scale_function: isLatest ? b.scale_function : current.scale_function,
        needs_review: isLatest ? b.needs_review : current.needs_review,
        // Full history of the biomarker (all readings except the one at this
        // blood test), not just the readings that occurred before it — so the
        // inline graph and reading list show the complete trend regardless of
        // which blood test entry is selected.
        history: [...all.slice(0, idx), ...all.slice(idx + 1)],
      }
    })
    .filter((x): x is BiomarkerResult => x !== null)
}
