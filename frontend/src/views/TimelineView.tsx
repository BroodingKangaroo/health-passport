'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { NavBar } from '@/components/shared/NavBar'
import { HistoryList } from '@/components/health-passport/history-list'
import { DoctorVisitDetails } from '@/components/health-passport/doctor-visit-details'
import { BloodTestDetails } from '@/components/health-passport/blood-test-details'
import { useTimelineData } from '@/hooks/useTimelineData'
import type { MedicalEvent, BiomarkerResult, Status, Reading } from '@/lib/types'

export function TimelineView() {
  const router = useRouter()
  const { data, isLoading, error } = useTimelineData()
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)

  const events: MedicalEvent[] = data?.events ?? []
  const biomarkers = data?.biomarkers ?? []
  const visits = data?.visits ?? {}
  // Default to the most recent event (events are date-ascending, so the last
  // element is newest) until the user picks one; never a stale hardcoded id.
  const effectiveSelected =
    selectedEvent ?? events[events.length - 1]?.id ?? events[0]?.id ?? ''
  const selectedEventData = events.find((e) => e.id === effectiveSelected)

  const eventBiomarkers = useMemo(
    () => biomarkersAtDate(biomarkers, selectedEventData?.date ?? ''),
    [biomarkers, selectedEventData?.date],
  )

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <HeaderBar />
        <NavBar activeTab="timeline" />
        <main className="mx-auto max-w-[1400px] p-5 text-center text-sm text-muted-foreground">
          Loading...
        </main>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background">
        <HeaderBar />
        <NavBar activeTab="timeline" />
        <main className="mx-auto max-w-[1400px] p-5 text-center text-sm text-status-high">
          Failed to load data. Is the backend running?
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />
      <NavBar activeTab="timeline" />

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
            <DoctorVisitDetails visit={visits[selectedEventData.id]} />
          ) : selectedEventData?.type === 'doctor_visit' ? (
            <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">
              <p>Visit details not yet available.</p>
            </div>
          ) : selectedEventData?.type === 'blood_test' ? (
            <BloodTestDetails
              event={selectedEventData}
              biomarkers={eventBiomarkers}
              onViewDetails={(id) => router.push('/details?id=' + id + '&from=timeline')}
            />
          ) : selectedEventData ? (
            <div className="flex h-full min-h-[300px] items-center justify-center text-sm text-muted-foreground">
              <p>No detailed view available for this event type.</p>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  )
}

function biomarkersAtDate(biomarkers: BiomarkerResult[], date: string): BiomarkerResult[] {
  if (!date) return biomarkers
  return biomarkers
    .map((b): BiomarkerResult | null => {
      const all: Reading[] = [
        ...(b.history ?? []),
        { date: b.date, value: b.value, status: b.status },
      ]
      const idx = all.findIndex((r) => r.date === date)
      if (idx === -1) return null
      const current = all[idx]
      return {
        ...b,
        value: current.value,
        date: current.date,
        status: current.status as Status,
        history: all.slice(0, idx),
      }
    })
    .filter((b): b is BiomarkerResult => b !== null)
}
