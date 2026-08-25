'use client'

import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'

// Confirmation before a replacement document's AI extraction overwrites the
// form data extracted from the previous document. Rendered only while a
// replacement extraction is pending confirmation (fileName !== null).
export function ExtractionConfirmDialog({
  fileName,
  onConfirm,
  onCancel,
}: {
  fileName: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  if (fileName === null) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-xl bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div>
            <h2 className="text-lg font-semibold text-foreground">Re-run AI extraction?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A fresh extraction of{' '}
              <span className="font-medium text-foreground">{fileName}</span> will replace the
              data currently in the form, which came from the previous document.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Keep current data
          </Button>
          <Button onClick={onConfirm}>Extract new document</Button>
        </div>
      </div>
    </div>
  )
}
