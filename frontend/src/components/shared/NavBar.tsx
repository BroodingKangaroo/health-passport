'use client'

import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useLeaveGuard } from '@/providers/leave-guard-provider'

type NavTab = 'timeline' | 'flowsheet' | 'correlation'

const TABS: { id: NavTab; label: string; path: string }[] = [
  { id: 'timeline', label: 'Timeline & Vitals', path: '/' },
  { id: 'flowsheet', label: 'Lab Flowsheet (Matrix)', path: '/flowsheet' },
  { id: 'correlation', label: 'Insights & Correlation', path: '/correlation' },
]

export function NavBar({ activeTab }: { activeTab: NavTab }) {
  const router = useRouter()
  const { confirmLeave } = useLeaveGuard()

  // Navigating away mid-process (AI extraction / translation) cancels it.
  function navigate(path: string) {
    void confirmLeave().then((ok) => {
      if (ok) router.push(path)
    })
  }

  return (
    <nav className="border-b border-border bg-card px-5 print:hidden">
      <div className="flex items-center gap-1">
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab
          return (
            <button
              key={tab.id}
              onClick={() => navigate(tab.path)}
              className={cn(
                'relative px-3 py-3 text-sm font-medium transition-colors',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
              {isActive && (
                <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
