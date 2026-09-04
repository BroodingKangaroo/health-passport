'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { NavBar } from '@/components/shared/NavBar'
import { HistoryList } from '@/components/health-passport/history-list'
import { DoctorVisitDetails } from '@/components/health-passport/doctor-visit-details'
import { BloodTestDetails } from '@/components/health-passport/blood-test-details'
import { InstrumentalTestDetails } from '@/components/health-passport/instrumental-test-details'
import { useTimelineData } from '@/hooks/useTimelineData'
import type { MedicalEvent, BiomarkerResult, Reading, TimelineResponse } from '@/lib/types'

export function TimelineView() {
  const router = useRouter()
  const { data, isLoading, error, refetch } = useTimelineData()
  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />
      <NavBar activeTab="timeline" />
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
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)

  const events: MedicalEvent[] = data?.events ?? []
  const biomarkers = useMemo(() => data?.biomarkers ?? [], [data?.biomarkers])
  const visits = data?.visits ?? {}
  const instrumental = data?.instrumental ?? {}
  // Default to the most recent event (events are date-ascending, so the last
  // element is newest) until the user picks one; never a stale hardcoded id.
  const effectiveSelected =
    selectedEvent ?? events[events.length - 1]?.id ?? events[0]?.id ?? ''
  const selectedEventData = events.find((e) => e.id === effectiveSelected)

  const eventBiomarkers = useMemo(
    () => biomarkersAtDate(biomarkers, selectedEventData?.id ?? ''),
    [biomarkers, selectedEventData?.id],
  )

  if (isLoading) {
    return (
      <main className="mx-auto max-w-[1400px] p-5 text-center text-sm text-muted-foreground">
        {tc('loading')}
      </main>
    )
  }

  if (error) {
    return (
      <main className="mx-auto max-w-[1400px] p-5 text-center text-sm text-status-high">
        {t('loadError')}
      </main>
    )
  }

  return (
    <main className="mx-auto grid max-w-[1400px] gap-5 p-5 lg:grid-cols-[minmax(240px,28%)_1fr]">
      <aside>
        <HistoryList
          events={events}
          selectedId={effectiveSelected}
          onSelect={setSelectedEvent}
          biomarkers={biomarkers}
        />
      </aside>
      <section className="min-w-0 overflow-x-hidden">
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
        ) : selectedEventData ? (
          <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">
            <p>{t('noDetailView')}</p>
          </div>
        ) : null}
      </section>
    </main>
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
