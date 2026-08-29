'use client'

import { AlertTriangle } from 'lucide-react'
import { useTranslations } from 'next-intl'

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
  const t = useTranslations('extractionConfirm')
  if (fileName === null) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-xl bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.rich('description', {
                fileName,
                file: (chunks) => (
                  <span className="font-medium text-foreground">{chunks}</span>
                ),
              })}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t('keepCurrent')}
          </Button>
          <Button onClick={onConfirm}>{t('extractNew')}</Button>
        </div>
      </div>
    </div>
  )
}
