'use client'

import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'

/**
 * Dead-end-free load failure: a short message plus a retry action. Used by
 * the timeline/flowsheet/correlation views — a transient fetch failure used
 * to strand the user on a page with no way to recover but a manual reload.
 */
export function LoadErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const t = useTranslations('common')
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm text-status-high">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  )
}
