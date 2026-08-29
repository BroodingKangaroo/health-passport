'use client'

import { AlertTriangle, Sigma } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'

/**
 * Small inline indicator for a reading whose value went through a
 * cross-scale conversion (`scale_function` like "10^x" / "log10") or
 * whose conversion could not be determined (`needs_review`). Surfaces
 * the original in a tooltip so the user can see what was in the source.
 */
export function ScaleNote({
  scaleFunction,
  needsReview,
  originalValue,
  originalUnit,
  className,
}: {
  scaleFunction?: string | null
  needsReview?: boolean
  originalValue?: string | null
  originalUnit?: string | null
  className?: string
}) {
  const t = useTranslations('misc.scaleNote')
  if (!scaleFunction && !needsReview) return null
  const hasOriginal = originalValue !== undefined && originalValue !== null && originalValue !== ''
  const tipParts: string[] = []
  if (hasOriginal) {
    tipParts.push(
      originalUnit
        ? t('originalWithUnit', { value: originalValue, unit: originalUnit })
        : t('original', { value: originalValue }),
    )
  }
  if (scaleFunction) {
    tipParts.push(t('convertedVia', { fn: scaleFunction }))
  }
  if (needsReview && !scaleFunction) {
    tipParts.push(t('notConverted'))
  }
  const tip = tipParts.join(' • ')
  const label =
    needsReview && !scaleFunction
      ? t('needsReview')
      : t('convertedVia', { fn: scaleFunction ?? '' })
  return (
    <span
      className={cn('inline-flex items-center gap-0.5 text-amber-600', className)}
      title={tip || label}
      aria-label={tip || label}
    >
      {needsReview && !scaleFunction ? (
        <AlertTriangle className="size-3" />
      ) : (
        <Sigma className="size-3" />
      )}
    </span>
  )
}
