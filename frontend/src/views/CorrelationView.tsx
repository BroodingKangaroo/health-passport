'use client'

import { useTranslations } from 'next-intl'
import { HeaderBar } from '@/components/health-passport/header-bar'
import { NavBar } from '@/components/shared/NavBar'
import { CorrelationChart } from '@/components/health-passport/correlation-chart'
import { useTimelineData } from '@/hooks/useTimelineData'

export function CorrelationView() {
  const t = useTranslations('correlation.view')
  const { data, isLoading, error } = useTimelineData()
  const biomarkers = data?.biomarkers ?? []

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <HeaderBar />
        <NavBar activeTab="correlation" />
        <main className="mx-auto max-w-[1400px] p-5 text-center text-sm text-muted-foreground">
          {t('loading')}
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
          {t('failedToLoad')}
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <HeaderBar />
      <NavBar activeTab="correlation" />
      <main className="mx-auto min-h-0 w-full max-w-[1400px] flex-1 p-5">
        <CorrelationChart biomarkers={biomarkers} />
      </main>
    </div>
  )
}
