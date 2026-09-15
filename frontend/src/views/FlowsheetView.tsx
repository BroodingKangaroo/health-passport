'use client'

import { useTranslations } from 'next-intl'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { NavBar } from '@/components/shared/NavBar'
import { LoadErrorState } from '@/components/shared/LoadErrorState'
import { FlowsheetMatrix } from '@/components/health-passport/flowsheet-matrix'
import { useFlowsheetData } from '@/hooks/useFlowsheetData'

export function FlowsheetView() {
  const t = useTranslations('timeline.views.flowsheet')
  const tc = useTranslations('common')
  const { data, isLoading, error, refetch } = useFlowsheetData()

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <HeaderBar />
        <NavBar activeTab="flowsheet" />
        <main className="p-5 text-center text-sm text-muted-foreground">
          {tc('loading')}
        </main>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background">
        <HeaderBar />
        <NavBar activeTab="flowsheet" />
        <main className="p-5">
          <LoadErrorState message={t('loadError')} onRetry={refetch} />
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />
      <NavBar activeTab="flowsheet" />
      <main className="w-full p-4 xl:px-6">
        <FlowsheetMatrix
          dates={data!.dates}
          matrix={data!.matrix}
          biomarkers={data!.biomarkers}
        />
      </main>
    </div>
  )
}
