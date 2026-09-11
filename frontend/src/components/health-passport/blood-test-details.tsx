'use client'

import { useState, useCallback, useEffect, useId, useRef } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { FlaskConical, Paperclip, Settings } from 'lucide-react'

import { cn } from '@/lib/utils'
import { TYPE_VISUALS } from '@/lib/event-visuals'
import { ResultsPanel } from './results-panel'
import { EntrySettings } from './entry-settings'
import { DocumentTab } from './document-tab'
import type { MedicalEvent, BiomarkerResult } from '@/lib/types'

type DetailTab = 'results' | 'document' | 'settings'

interface BloodTestDetailsProps {
  event: MedicalEvent
  biomarkers: BiomarkerResult[]
  // Expand-row → /details navigation; omitted on the demo surface (no
  // backing API payload), which hides the button instead.
  onViewDetails?: (id: string) => void
  onDeleted?: () => void
}

export function BloodTestDetails({
  event,
  biomarkers,
  onViewDetails,
  onDeleted,
}: BloodTestDetailsProps) {
  const t = useTranslations('timeline.bloodTest')
  const te = useTranslations('timeline.entrySettings')
  const locale = useLocale()
  const TypeIcon = TYPE_VISUALS.blood_test.icon
  const tabBaseId = useId()
  const [activeTab, setActiveTab] = useState<DetailTab>('results')
  const tabsRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({})
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false })

  const attachments = event.attachments ?? []

  // Same nowrap + edge-fade affordance as the HistoryList type chips: the
  // 28px-tall strip never wraps, so long RU labels scroll instead.
  const updateTabOverflow = useCallback(() => {
    const el = tabsRef.current
    if (!el) return
    setTabOverflow({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    })
  }, [])

  useEffect(() => {
    updateTabOverflow()
    const el = tabsRef.current
    if (!el) return
    el.addEventListener('scroll', updateTabOverflow, { passive: true })
    window.addEventListener('resize', updateTabOverflow)
    return () => {
      el.removeEventListener('scroll', updateTabOverflow)
      window.removeEventListener('resize', updateTabOverflow)
    }
  }, [updateTabOverflow, locale, attachments.length])

  const tabId = (tab: DetailTab) => `${tabBaseId}-tab-${tab}`
  const panelId = (tab: DetailTab) => `${tabBaseId}-panel-${tab}`

  const selectTab = useCallback((tab: DetailTab) => {
    setActiveTab(tab)
    tabRefs.current[tab]?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [])

  const TABS: { id: DetailTab; label: string; icon: typeof FlaskConical }[] = [
    { id: 'results', label: t('testResults'), icon: FlaskConical },
    { id: 'document', label: t('documents', { count: attachments.length }), icon: Paperclip },
    { id: 'settings', label: t('settings'), icon: Settings },
  ]

  return (
    <div className="flex h-full w-full min-h-0 flex-col gap-3 bg-background print:block print:h-auto">
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
            TYPE_VISUALS.blood_test.chipClass,
          )}
        >
          <TypeIcon className="size-3.5" />
          {te('typeBloodTest')}
        </span>
        <div className="relative min-w-0 flex-1">
          {tabOverflow.left && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-background to-transparent"
            />
          )}
          {tabOverflow.right && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 z-10 w-5 bg-gradient-to-l from-background to-transparent"
            />
          )}
          <div
            ref={tabsRef}
            role="tablist"
            className="scrollbar-none flex h-7 flex-nowrap items-stretch overflow-x-auto px-1"
          >
            {TABS.map((tab) => {
              const Icon = tab.icon
              const active = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[tab.id] = el
                  }}
                  type="button"
                  role="tab"
                  id={tabId(tab.id)}
                  aria-selected={active}
                  aria-controls={panelId(tab.id)}
                  onClick={() => selectTab(tab.id)}
                  onFocus={(e) => e.currentTarget.scrollIntoView({ inline: 'nearest', block: 'nearest' })}
                  className={cn(
                    'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-sm font-medium transition-colors',
                    active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {tab.label}
                  {active && (
                    <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {activeTab === 'results' ? (
        <div
          role="tabpanel"
          id={panelId('results')}
          aria-labelledby={tabId('results')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ResultsPanel date={event.date} labName={event.clinic} title={event.title} entryId={event.id} biomarkers={biomarkers} onViewDetails={onViewDetails} />
        </div>
      ) : activeTab === 'document' ? (
        <div
          role="tabpanel"
          id={panelId('document')}
          aria-labelledby={tabId('document')}
          className="flex w-full min-w-0 flex-1 flex-col min-h-0"
        >
          <DocumentTab attachments={attachments} />
        </div>
      ) : (
        <div
          role="tabpanel"
          id={panelId('settings')}
          aria-labelledby={tabId('settings')}
          tabIndex={0}
          className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <EntrySettings
            event={event}
            biomarkers={biomarkers}
            onDeleted={onDeleted ?? (() => {})}
          />
        </div>
      )}
    </div>
  )
}
