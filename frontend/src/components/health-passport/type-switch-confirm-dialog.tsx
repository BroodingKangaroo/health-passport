'use client'

import { useId } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'

// Confirmation before a document-type switch resets the companion form state.
// Correcting an AI misclassification must not silently discard the extracted
// rows / visit / instrumental data already in the form. Rendered only while
// a type switch is pending confirmation.
export function TypeSwitchConfirmDialog({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useTranslations('typeSwitchConfirm')
  const titleId = useId()

  return (
    <ModalDialog
      open={pending}
      onClose={onCancel}
      labelledBy={titleId}
      panelClassName="max-w-md rounded-xl bg-background p-6 shadow-xl"
    >
      <div className="mb-4 flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
        <div>
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t('keepCurrent')}
        </Button>
        <Button onClick={onConfirm}>{t('switchType')}</Button>
      </div>
    </ModalDialog>
  )
}
