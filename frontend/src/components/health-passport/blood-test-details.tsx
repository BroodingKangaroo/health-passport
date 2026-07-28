'use client'

import { useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { FileText, Download, Printer, FlaskConical, Paperclip, Settings } from 'lucide-react'

import { cn, fetchAuthedObjectUrl, printAuthedDocument } from '@/lib/utils'
import { ResultsPanel } from './results-panel'
import { EntrySettings } from './entry-settings'
import type { MedicalEvent, BiomarkerResult } from '@/lib/types'

const DocumentViewer = dynamic(
  () => import('@/components/shared/DocumentViewer').then((m) => m.DocumentViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[300px] items-center justify-center text-sm text-muted-foreground">
        Loading document viewer...
      </div>
    ),
  },
)

interface BloodTestDetailsProps {
  event: MedicalEvent
  biomarkers: BiomarkerResult[]
  onViewDetails: (id: string) => void
  onDeleted?: () => void
}

export function BloodTestDetails({
  event,
  biomarkers,
  onViewDetails,
  onDeleted,
}: BloodTestDetailsProps) {
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
    <div className="flex h-full w-full flex-col bg-background px-6 pb-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          onClick={() => setActiveTab('results')}
          className={
            activeTab === 'results'
              ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-foreground'
              : 'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
          }
        >
          <FlaskConical className="size-4" />
          Test Results
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
          Documents ({attachments.length})
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
          Settings
        </button>
      </div>

      {activeTab === 'results' ? (
        <div className="mt-5 flex-1 overflow-y-auto">
          <ResultsPanel date={event.date} labName={event.clinic} biomarkers={biomarkers} onViewDetails={onViewDetails} />
        </div>
      ) : activeTab === 'document' ? (
        <div className="mt-5 flex w-full min-w-0 flex-1 flex-col min-h-0">
          {attachments.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No documents available for this event.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {attachments.map((att) => {
                const isActive = activeId === att.id
                const url = att.url
                return (
                  <div
                    key={att.id}
                    onClick={() => setActiveAttachmentId(att.id)}
                    className={cn(
                      'flex cursor-pointer items-center justify-between rounded-xl border p-4 transition-colors',
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
                         Print
                       </button>
                       )}
                       {url && (
                       <button
                         onClick={(e) => { e.stopPropagation(); handleDownload(att.name, url) }}
                         className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                       >
                         <Download className="size-4" />
                         Download
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
                Viewing:{' '}
                {selectedAttachment.name}
              </p>
              <div className="flex-1 min-h-0 w-full overflow-hidden rounded-xl border border-border">
                <DocumentViewer key={selectedAttachment.url} url={selectedAttachment.url} />
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mt-5 flex-1 min-h-0">
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

async function handlePrintDocument(url: string) {
  printAuthedDocument(url).catch((e) => console.error('Print failed', e))
}
