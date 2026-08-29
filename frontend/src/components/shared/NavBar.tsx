'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { useLeaveGuard } from '@/providers/leave-guard-provider'

type NavTab = 'timeline' | 'flowsheet' | 'correlation'

const TABS: { id: NavTab; path: string }[] = [
  { id: 'timeline', path: '/' },
  { id: 'flowsheet', path: '/flowsheet' },
  { id: 'correlation', path: '/correlation' },
]

export function NavBar({ activeTab }: { activeTab: NavTab }) {
  const router = useRouter()
  const t = useTranslations('misc.nav')
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
              {t(tab.id)}
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
