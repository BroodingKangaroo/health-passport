'use client'

import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { HeaderBar } from '@/components/health-passport/header-bar'
import { HistoryList } from '@/components/health-passport/history-list'
import { ResultsPanel } from '@/components/health-passport/results-panel'
import { FlowsheetMatrix } from '@/components/health-passport/flowsheet-matrix'
import { BiomarkerDetails } from '@/components/health-passport/biomarker-details'
import { AddEntry } from '@/components/health-passport/add-entry'

type View = 'timeline' | 'flowsheet' | 'details' | 'add-entry'

const tabs: { id: Exclude<View, 'details'>; label: string }[] = [
  { id: 'timeline', label: 'Timeline & Vitals' },
  { id: 'flowsheet', label: 'Lab Flowsheet (Matrix)' },
]

export default function Page() {
  const [currentView, setCurrentView] = useState<View>('timeline')
  const [selectedEvent, setSelectedEvent] = useState('blood-oct')

  return (
    <div className="min-h-screen bg-background">
      <HeaderBar onAddEntry={() => setCurrentView('add-entry')} />

      {/* Sub-header */}
      <nav className="border-b border-border bg-card px-5">
        {currentView === 'details' || currentView === 'add-entry' ? (
          <div className="flex items-center py-2">
            <Button
              variant="ghost"
              onClick={() => setCurrentView('timeline')}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              {currentView === 'add-entry' ? 'Back to Dashboard' : 'Back to Timeline'}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setCurrentView(tab.id)}
                className={cn(
                  'relative px-3 py-3 text-sm font-medium transition-colors',
                  currentView === tab.id
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
                {currentView === tab.id && (
                  <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
                )}
              </button>
            ))}
          </div>
        )}
      </nav>

      {/* Views */}
      {currentView === 'timeline' && (
        <main className="mx-auto grid max-w-[1400px] gap-5 p-5 lg:grid-cols-[minmax(240px,28%)_1fr]">
          <aside>
            <HistoryList selectedId={selectedEvent} onSelect={setSelectedEvent} />
          </aside>
          <section>
            <ResultsPanel onViewDetails={() => setCurrentView('details')} />
          </section>
        </main>
      )}

      {currentView === 'flowsheet' && (
        <main className="mx-auto max-w-[1400px] p-5">
          <FlowsheetMatrix />
        </main>
      )}

      {currentView === 'details' && (
        <main className="p-5">
          <BiomarkerDetails />
        </main>
      )}

      {currentView === 'add-entry' && (
        <main className="p-5">
          <AddEntry onSave={() => setCurrentView('timeline')} />
        </main>
      )}
    </div>
  )
}
