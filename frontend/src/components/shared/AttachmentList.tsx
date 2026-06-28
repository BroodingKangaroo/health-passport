'use client'

import { useCallback } from 'react'
import { FileText, Eye, Download } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EventAttachment } from '@/lib/types'

interface AttachmentListProps {
  attachments: EventAttachment[]
  activeId: string | null
  onSelect: (id: string) => void
  onDownload: (name: string) => void
}

export function AttachmentList({ attachments, activeId, onSelect, onDownload }: AttachmentListProps) {
  if (attachments.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No documents available for this event.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {attachments.map((att) => {
        const isActive = activeId === att.id
        return (
          <div
            key={att.id}
            className={cn(
              'flex items-center justify-between rounded-xl border p-4 transition-colors',
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
              <button
                onClick={() => onSelect(att.id)}
                className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Eye className="size-4" />
                View
              </button>
              <button
                onClick={() => onDownload(att.name)}
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
  )
}
