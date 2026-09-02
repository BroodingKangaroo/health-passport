'use client'

import { useTimelineData } from '@/hooks/useTimelineData'
import { TimelineView } from '@/views/TimelineView'
import { LandingHero } from './landing-hero'

/**
 * Gates `/` on "zero entries": first-time visitors (fresh anonymous sessions
 * or accounts without data) get the landing hero. While the timeline is
 * loading or its fetch failed, the TimelineView renders — its own loading and
 * error states guarantee an existing user never sees the marketing surface.
 */
export function LandingGate() {
  const { data, isLoading, error } = useTimelineData()
  const showHero = !isLoading && !error && (data?.events?.length ?? 0) === 0
  return showHero ? <LandingHero /> : <TimelineView />
}
