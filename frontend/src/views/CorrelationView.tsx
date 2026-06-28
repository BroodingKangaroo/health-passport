'use client'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { NavBar } from '@/components/shared/NavBar'
import { CorrelationChart } from '@/components/health-passport/correlation-chart'
import { useTimelineData } from '@/hooks/useTimelineData'

export function CorrelationView() {
  const { data, isLoading, error } = useTimelineData()
  const biomarkers = data?.biomarkers ?? []

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <HeaderBar />
        <NavBar activeTab="correlation" />
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
        <NavBar activeTab="correlation" />
        <main className="mx-auto max-w-[1400px] p-5 text-center text-sm text-status-high">
          Failed to load data. Is the backend running?
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />
      <NavBar activeTab="correlation" />
      <main className="mx-auto max-w-[1400px] p-5">
        <CorrelationChart biomarkers={biomarkers} />
      </main>
    </div>
  )
}
