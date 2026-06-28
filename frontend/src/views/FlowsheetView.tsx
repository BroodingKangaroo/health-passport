'use client'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { NavBar } from '@/components/shared/NavBar'
import { FlowsheetMatrix } from '@/components/health-passport/flowsheet-matrix'
import { useFlowsheetData } from '@/hooks/useFlowsheetData'

export function FlowsheetView() {
  const { data, isLoading, error } = useFlowsheetData()

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <HeaderBar />
        <NavBar activeTab="flowsheet" />
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
        <NavBar activeTab="flowsheet" />
        <main className="mx-auto max-w-[1400px] p-5 text-center text-sm text-status-high">
          Failed to load flowsheet data. Is the backend running?
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />
      <NavBar activeTab="flowsheet" />
      <main className="mx-auto max-w-[1400px] p-5">
        <FlowsheetMatrix
          dates={data!.dates}
          matrix={data!.matrix}
          biomarkers={data!.biomarkers}
        />
      </main>
    </div>
  )
}
