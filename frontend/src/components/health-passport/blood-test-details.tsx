'use client'

import { useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
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
  const TypeIcon = TYPE_VISUALS.blood_test.icon
  const [activeTab, setActiveTab] = useState<'results' | 'document' | 'settings'>('results')

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

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-background pb-6 print:block print:h-auto">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
            TYPE_VISUALS.blood_test.chipClass,
          )}
        >
          <TypeIcon className="size-3.5" />
          {te('typeBloodTest')}
        </span>
        <span aria-hidden className="text-sm text-muted-foreground/20">|</span>
        <button
          onClick={() => setActiveTab('results')}
          className={
            activeTab === 'results'
              ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-foreground'
              : 'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
          }
        >
          <FlaskConical className="size-4" />
          {t('testResults')}
        </button>
        <span className="text-sm text-muted-foreground/20">|</span>
        <button
          onClick={() => setActiveTab('document')}
          className={
            activeTab === 'document'
              ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-foreground'
              : 'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
          }
        >
          <Paperclip className="size-4" />
          {t('documents', { count: attachments.length })}
        </button>
        <span className="text-sm text-muted-foreground/20">|</span>
        <button
          onClick={() => setActiveTab('settings')}
          className={
            activeTab === 'settings'
              ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-foreground'
              : 'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
          }
        >
          <Settings className="size-4" />
          {t('settings')}
        </button>
      </div>

      {activeTab === 'results' ? (
        <div className="mt-5 flex min-h-0 flex-1 flex-col">
          <ResultsPanel date={event.date} labName={event.clinic} entryId={event.id} biomarkers={biomarkers} onViewDetails={onViewDetails} />
        </div>
      ) : activeTab === 'document' ? (
        <div className="mt-5 flex w-full min-w-0 flex-1 flex-col min-h-0">
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
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
