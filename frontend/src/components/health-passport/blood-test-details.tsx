'use client'

import { useState, useCallback, useEffect, useId, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useLocale, useTranslations } from 'next-intl'
import { FileText, Download, Printer, FlaskConical, Paperclip, Settings } from 'lucide-react'

import { cn, fetchAuthedObjectUrl, printAuthedDocument } from '@/lib/utils'
import { activateOnKey } from '@/lib/a11y'
import { TYPE_VISUALS } from '@/lib/event-visuals'
import { ResultsPanel } from './results-panel'
import { EntrySettings } from './entry-settings'
import type { MedicalEvent, BiomarkerResult } from '@/lib/types'

function ViewerLoadingFallback() {
  const t = useTranslations('timeline.bloodTest')
  return (
    <div className="flex min-h-[300px] items-center justify-center text-sm text-muted-foreground">
      {t('loadingViewer')}
    </div>
  )
}

const DocumentViewer = dynamic(
  () => import('@/components/shared/DocumentViewer').then((m) => m.DocumentViewer),
  {
    ssr: false,
    loading: () => <ViewerLoadingFallback />,
  },
)

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
  const [activeAttachmentId, setActiveAttachmentId] = useState<string | null>(null)

  const selectedAttachment =
    attachments.find((a) => a.id === activeAttachmentId) ??
    attachments.find((a) => a.url) ??
    attachments[0] ??
    null
  const activeId = selectedAttachment?.id ?? null

  const handleDownload = useCallback(async (name: string, url: string) => {
    try {
      const objectUrl = await fetchAuthedObjectUrl(url)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch (e) {
      console.error('Download failed', e)
    }
  }, [])

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
    <div className="flex h-full w-full min-h-0 flex-col gap-3 bg-background pb-6 print:block print:h-auto">
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
            className="flex h-7 flex-nowrap items-stretch overflow-x-auto border-b border-border px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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

      {/* 22px meta slot: keeps the details header zone at 28 + 12 + 22 + 12 = 74px, matching HistoryList (§5.5). */}
      <div className="h-[22px] shrink-0" />

      {activeTab === 'results' ? (
        <div
          role="tabpanel"
          id={panelId('results')}
          aria-labelledby={tabId('results')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ResultsPanel date={event.date} labName={event.clinic} entryId={event.id} biomarkers={biomarkers} onViewDetails={onViewDetails} />
        </div>
      ) : activeTab === 'document' ? (
        <div
          role="tabpanel"
          id={panelId('document')}
          aria-labelledby={tabId('document')}
          className="flex w-full min-w-0 flex-1 flex-col min-h-0"
        >
          {attachments.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('noDocuments')}
            </p>
          ) : (
            <div className="flex max-h-72 shrink-0 flex-col gap-3 overflow-y-auto overscroll-contain print:max-h-none print:overflow-visible">
              {attachments.map((att) => {
                const isActive = activeId === att.id
                const url = att.url
                return (
                  <div
                    key={att.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isActive}
                    onClick={() => setActiveAttachmentId(att.id)}
                    onKeyDown={(e) => activateOnKey(e, () => setActiveAttachmentId(att.id))}
                    className={cn(
                      'flex cursor-pointer items-center justify-between rounded-xl border p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isActive
                        ? 'border-muted-foreground/50 bg-muted/20'
                        : 'border-border bg-card hover:bg-muted/10',
                    )}
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <FileText className="size-5 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 leading-tight">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {att.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {att.description ?? att.type}
                          {att.size ? ` · ${att.size}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                       {url && (
                       <button
                         onClick={(e) => { e.stopPropagation(); printAuthedDocument(url) }}
                         className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                       >
                        <Printer className="size-4" />
                        {t('print')}
                      </button>
                       )}
                       {url && (
                       <button
                         onClick={(e) => { e.stopPropagation(); handleDownload(att.name, url) }}
                         className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                       >
                         <Download className="size-4" />
                         {t('download')}
                       </button>
                       )}
                     </div>
                  </div>
                )
              })}
            </div>
          )}

          {selectedAttachment && (
            <>
              <p className="mt-4 mb-2 text-xs text-muted-foreground">
                {t('viewing', { name: selectedAttachment.name })}
              </p>
              <div className="min-h-0 flex-1 w-full overflow-y-auto rounded-xl border border-border">
                <DocumentViewer key={selectedAttachment.url} url={selectedAttachment.url} />
              </div>
            </>
          )}
        </div>
      ) : (
        <div
          role="tabpanel"
          id={panelId('settings')}
          aria-labelledby={tabId('settings')}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
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
