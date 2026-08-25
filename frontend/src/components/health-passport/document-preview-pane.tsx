'use client'

import dynamic from 'next/dynamic'
import { X, FileText, ImagePlus } from 'lucide-react'

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

interface DocumentPreviewPaneProps {
  objectUrl: string | null
  selectedFile: File | null
  onRemove: () => void
  // Opens the attach picker for an empty slot; backed by the hidden file
  // input that lives next to Save so the picked file reaches the save
  // payload (and re-runs extraction in AI mode).
  onAttachClick: () => void
}

export function DocumentPreviewPane({
  objectUrl,
  selectedFile,
  onRemove,
  onAttachClick,
}: DocumentPreviewPaneProps) {
  return (
    <div className="sticky top-6 relative w-[45%] overflow-hidden rounded-xl border bg-card">
      {objectUrl && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove document"
          aria-label="Remove document"
          className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      {objectUrl ? (
        selectedFile?.type === 'application/pdf' ? (
          <DocumentViewer key={objectUrl} url={objectUrl} />
        ) : selectedFile?.type.startsWith('image/') ? (
          <div className="flex h-full w-full items-center justify-center p-4">
            <div className="relative h-full w-full overflow-hidden rounded-lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={objectUrl}
                alt={selectedFile?.name ?? 'Uploaded image'}
                className="h-full w-full object-contain"
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-4">
            <h2 className="mb-3 text-sm font-semibold text-foreground">Attached Document</h2>
            <div className="flex aspect-[3/4] w-full max-w-xs flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted/60 text-center">
              <FileText className="size-10 text-muted-foreground/60" />
              <p className="text-xs font-medium text-foreground">{selectedFile?.name ?? 'Document'}</p>
              {selectedFile && (
                <p className="text-[11px] text-muted-foreground">
                  {(selectedFile.size / 1024).toFixed(0)} KB
                </p>
              )}
            </div>
          </div>
        )
      ) : (
        <div className="flex h-full flex-col items-center justify-center p-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Attachments (Optional)</h2>
          <button
            type="button"
            onClick={onAttachClick}
            className="flex aspect-[3/4] w-full max-w-xs flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-background/60 px-4 text-center transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ImagePlus className="size-6" />
            </div>
            <p className="text-xs font-medium text-foreground">
              {selectedFile?.name ?? 'Add a photo or scan'}
            </p>
            <p className="text-[11px] text-muted-foreground">Click to attach</p>
          </button>
        </div>
      )}
    </div>
  )
}
