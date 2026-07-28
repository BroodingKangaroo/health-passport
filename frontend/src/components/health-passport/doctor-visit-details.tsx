'use client'

import { useState, useCallback, Fragment } from 'react'
import dynamic from 'next/dynamic'
import {
  Stethoscope,
  Building,
  Activity,
  CheckCircle,
  FileText,
  Pill,
  Download,
  Printer,
  Paperclip,
  Languages,
  Settings,
} from 'lucide-react'

import { cn, fetchAuthedObjectUrl, printAuthedDocument } from '@/lib/utils'
import { EntrySettings } from './entry-settings'
import type { VisitData } from '@/lib/types'

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

export function DoctorVisitDetails({ visit, onDeleted }: { visit: VisitData; onDeleted?: () => void }) {
  const [activeTab, setActiveTab] = useState<'summary' | 'document' | 'settings'>('summary')
  const [showOriginal, setShowOriginal] = useState(false)
  const [activeAttachmentId, setActiveAttachmentId] = useState<string | null>(null)

  const selectedAttachment =
    visit.attachments.find((a) => a.id === activeAttachmentId) ??
    visit.attachments.find((a) => a.url) ??
    visit.attachments[0] ??
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

  const verdictText = showOriginal ? visit.verdict.original : visit.verdict.translated_en
  const verdictLabel = showOriginal ? 'Original' : 'Translated'

  const eventForSettings = {
    id: visit.date ? `${visit.clinic}-${visit.date}` : visit.clinic,
    date: visit.date,
    type: 'doctor_visit' as const,
    title: visit.specialty,
    clinic: visit.clinic,
    attachments: visit.attachments,
  }

  return (
    <div className="flex h-full w-full flex-col bg-background px-6 pb-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            onClick={() => setActiveTab('summary')}
            className={
              activeTab === 'summary'
                ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-foreground'
                : 'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
            }
          >
            <FileText className="size-4" />
            {showOriginal ? 'Original Summary' : 'Translated Summary'}
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
            Original Document ({visit.attachments.length})
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

        {activeTab === 'summary' && (
          <button
            onClick={() => setShowOriginal(!showOriginal)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
              showOriginal
                ? 'border-blue-500/30 bg-blue-500/10 text-blue-600'
                : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted',
            )}
          >
            <Languages className="size-3.5" />
            {showOriginal ? 'Showing Original' : 'View Original Language'}
          </button>
        )}
      </div>

      {activeTab === 'summary' ? (
        <div className="mt-5 flex-1 space-y-6 overflow-y-auto">
          <div className="flex items-center gap-4 border-b border-border/40 pb-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Stethoscope className="size-4" />
              {visit.provider}
            </span>
            <span className="flex items-center gap-1.5">
              <Building className="size-4" />
              {visit.clinic}
            </span>
          </div>

          <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-6">
            <div className="mb-1 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-blue-500" />
                <span className="text-xs font-semibold uppercase tracking-wide text-blue-500">
                  Primary Diagnosis
                </span>
              </div>
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {verdictLabel}
              </span>
            </div>
            {verdictText ? (
              <p className="text-sm leading-relaxed text-foreground">
                {verdictText}
              </p>
            ) : (
              <p className="text-sm italic text-muted-foreground/50">
                No diagnosis recorded
              </p>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Clinical Notes
              </h3>
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {verdictLabel}
              </span>
            </div>
            <div className="space-y-6">
            {visit.notes.length > 0 ? visit.notes.map((note, i) => (
              <Fragment key={i}>
                <div>
                  {note.heading && (
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-foreground">
                        {note.heading}
                      </h3>
                      <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                        {verdictLabel}
                      </span>
                    </div>
                  )}
                  {(() => {
                    const noteText = showOriginal ? note.text_original : note.text_translated
                    return noteText ? (
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {noteText}
                      </p>
                    ) : (
                      <p className="mt-1 text-sm italic text-muted-foreground/50">
                        No {note.heading?.toLowerCase() || 'information'} recorded
                      </p>
                    )
                  })()}
                </div>
                {i === 1 && <div className="h-px bg-border/50" />}
              </Fragment>
            )) : (
              <p className="text-sm italic text-muted-foreground/50">
                No clinical notes recorded
              </p>
            )}
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Prescriptions
              </h3>
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {verdictLabel}
              </span>
            </div>
            {visit.prescriptions.length > 0 ? visit.prescriptions.map((p) => (
              <div
                key={p.id}
                className="mb-2 flex items-start gap-3 rounded-xl border border-border/50 bg-background p-3 transition-all hover:bg-background/80 cursor-pointer"
              >
                <Pill className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium text-foreground">
                      {showOriginal ? p.name.original : p.name.translated_en}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {showOriginal ? p.dose.original : p.dose.translated_en}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {showOriginal ? p.instruction.original : p.instruction.translated_en}
                  </p>
                </div>
              </div>
            )) : (
              <p className="text-sm italic text-muted-foreground/50">
                No prescriptions recorded
              </p>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Recommendations
              </h3>
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {verdictLabel}
              </span>
            </div>
            {visit.recommendations.length > 0 ? (
              <ul className="space-y-2">
                {visit.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 size-4 shrink-0 text-green-500" />
                    <span className="text-sm text-muted-foreground">
                      {showOriginal ? rec.original : rec.translated_en}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm italic text-muted-foreground/50">
                No recommendations recorded
              </p>
            )}
          </div>
        </div>
      ) : activeTab === 'document' ? (
        <div className="mt-5 flex w-full min-w-0 flex-1 flex-col min-h-0">
          {visit.attachments.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No documents available for this event.
            </p>
          ) : (
          <div className="flex flex-col gap-3">
              {visit.attachments.map((att) => {
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
                        {att.type} · {att.size}
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
                Viewing: {selectedAttachment.name}
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
            event={eventForSettings}
            visit={visit}
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