'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useLocale, useTranslations } from 'next-intl'
import { FileText, Download, Printer } from 'lucide-react'
import { toast } from 'sonner'

import { cn, fetchAuthedObjectUrl, printAuthedDocument } from '@/lib/utils'
import type { EventAttachment } from '@/lib/types'

function ViewerLoadingFallback() {
  const t = useTranslations('timeline.documents')
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

// Compact horizontal attachment strip shared by the blood-test, doctor-visit
// and instrumental-test detail views. One 36px row regardless of attachment
// count keeps the viewer at maximum height; per-file actions are icon buttons
// at the strip's right edge.
export function DocumentTab({ attachments }: { attachments: EventAttachment[] }) {
  const t = useTranslations('timeline.documents')
  const locale = useLocale()
  const [activeAttachmentId, setActiveAttachmentId] = useState<string | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [stripOverflow, setStripOverflow] = useState({ left: false, right: false })

  const selectedAttachment =
    attachments.find((a) => a.id === activeAttachmentId) ??
    attachments.find((a) => a.url) ??
    attachments[0] ??
    null
  const activeId = selectedAttachment?.id ?? null
  const selectedUrl = selectedAttachment?.url

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
      toast.error(t('downloadFailed'))
    }
  }, [t])

  const handlePrint = useCallback(async (url: string) => {
    try {
      await printAuthedDocument(url)
    } catch (e) {
      console.error('Print failed', e)
      toast.error(t('printFailed'))
    }
  }, [t])

  // Same nowrap + edge-fade affordance as the detail tab strip: the 36px-tall
  // row never wraps, so many attachments scroll horizontally.
  const updateStripOverflow = useCallback(() => {
    const el = stripRef.current
    if (!el) return
    setStripOverflow({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    })
  }, [])

  useEffect(() => {
    updateStripOverflow()
    const el = stripRef.current
    if (!el) return
    el.addEventListener('scroll', updateStripOverflow, { passive: true })
    window.addEventListener('resize', updateStripOverflow)
    return () => {
      el.removeEventListener('scroll', updateStripOverflow)
      window.removeEventListener('resize', updateStripOverflow)
    }
  }, [updateStripOverflow, locale, attachments.length])

  if (attachments.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t('noDocuments')}
      </p>
    )
  }

  const viewerActions =
    selectedAttachment && selectedUrl ? (
      <>
        <button
          type="button"
          onClick={() => void handlePrint(selectedUrl)}
          title={t('print')}
          aria-label={t('print')}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Printer className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => handleDownload(selectedAttachment.name, selectedUrl)}
          title={t('download')}
          aria-label={t('download')}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Download className="size-4" />
        </button>
      </>
    ) : undefined

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative w-full min-w-0 shrink-0">
        {stripOverflow.left && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-background to-transparent"
          />
        )}
        {stripOverflow.right && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-5 bg-gradient-to-l from-background to-transparent"
          />
        )}
        <div
          ref={stripRef}
          className="scrollbar-none flex h-9 flex-nowrap items-stretch gap-1.5 overflow-x-auto print:h-auto print:flex-wrap print:overflow-visible"
        >
          {attachments.map((att) => {
            const isActive = activeId === att.id
            const meta = [att.description ?? att.type, att.size].filter(Boolean).join(' · ')
            return (
              <button
                key={att.id}
                type="button"
                aria-pressed={isActive}
                title={meta ? `${att.name} · ${meta}` : att.name}
                onClick={() => setActiveAttachmentId(att.id)}
                className={cn(
                  'flex max-w-[18rem] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'border-muted-foreground/50 bg-muted/30 text-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted/10 hover:text-foreground',
                )}
              >
                <FileText className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{att.name}</span>
                {att.size && (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80">
                    {att.size}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {selectedAttachment && (
        <div className="mt-3 min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border">
          <DocumentViewer
            key={selectedAttachment.url}
            url={selectedAttachment.url}
            fill
            actions={viewerActions}
          />
        </div>
      )}
    </div>
  )
}
