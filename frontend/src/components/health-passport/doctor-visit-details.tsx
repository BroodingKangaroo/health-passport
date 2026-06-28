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
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type { VisitData } from '@/lib/types'

const DocumentViewer = dynamic(
  () => import('@/components/shared/DocumentViewer').then((m) => m.DocumentViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading document viewer...
      </div>
    ),
  },
)

export function DoctorVisitDetails({ visit }: { visit: VisitData }) {
  const [activeTab, setActiveTab] = useState<'summary' | 'document'>('summary')
  const [activeAttachmentId, setActiveAttachmentId] = useState(visit.attachments[0]?.id ?? null)

  const handleDownload = useCallback((name: string) => {
    const a = document.createElement('a')
    a.href = '/cardiology-notes.pdf'
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [])

  return (
    <div className="flex h-full w-full flex-col bg-background px-6 pb-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => setActiveTab('summary')}
          className={
            activeTab === 'summary'
              ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-foreground'
              : 'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
          }
        >
          <FileText className="size-4" />
          Translated Summary
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

          <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
            <div className="mb-1 flex items-center gap-2">
              <Activity className="size-4 text-blue-500" />
              <span className="text-xs font-semibold uppercase tracking-wide text-blue-500">
                Primary Diagnosis
              </span>
            </div>
            <p className="text-sm leading-relaxed text-foreground">
              {visit.verdict}
            </p>
          </div>

          <div className="bg-card border border-border rounded-xl p-6 space-y-6">
            {visit.notes.map((note, i) => (
              <Fragment key={i}>
                <div>
                  {note.heading && (
                    <h3 className="text-sm font-semibold text-foreground">
                      {note.heading}
                    </h3>
                  )}
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {note.text}
                  </p>
                </div>
                {i === 1 && <div className="h-px bg-border/50" />}
              </Fragment>
            ))}
          </div>

          {visit.prescriptions.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-6">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase mb-4">
                Prescriptions
              </h3>
              {visit.prescriptions.map((p) => (
                <div
                  key={p.id}
                  className="mb-3 flex items-center justify-between rounded-xl border border-border/50 bg-background p-4 transition-all hover:bg-background/80 cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Pill className="size-5 text-primary" />
                    <div>
                      <span className="text-sm font-medium text-foreground">{p.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{p.dose}</span>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground">{p.instruction}</span>
                </div>
              ))}
            </div>
          )}

          {visit.recommendations.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-6">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase mb-4">
                Recommendations
              </h3>
              <ul className="space-y-2">
                {visit.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 size-4 shrink-0 text-green-500" />
                    <span className="text-sm text-muted-foreground">{rec}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-5 flex w-full min-w-0 flex-1 flex-col min-h-0">
          <div className="flex flex-col gap-3">
            {visit.attachments.map((att) => {
              const isActive = activeAttachmentId === att.id
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
                      <button
                        onClick={(e) => { e.stopPropagation(); handlePrintDocument('/attachment-preview.pdf') }}
                        className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        <Printer className="size-4" />
                        Print
                      </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDownload(att.name) }}
                      className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      <Download className="size-4" />
                      Download
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <p className="mt-4 mb-2 text-xs text-muted-foreground">
            Viewing: {visit.attachments.find((a) => a.id === activeAttachmentId)?.name}
          </p>

          <div className="flex-1 min-h-0 w-full overflow-hidden rounded-xl border border-border">
            <DocumentViewer url="/attachment-preview.pdf" />
          </div>
        </div>
      )}
    </div>
  )
}

function handlePrintDocument(url: string) {
  const iframe = document.createElement('iframe')
  iframe.style.position = 'absolute'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)
  iframe.onload = () => {
    try { iframe.contentWindow?.focus() } catch {}
    try { iframe.contentWindow?.print() } catch {}
  }
  iframe.src = url
}
