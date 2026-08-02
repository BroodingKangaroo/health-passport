'use client'

import { AlertTriangle, Sigma } from 'lucide-react'
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
  if (!scaleFunction && !needsReview) return null
  const tipParts: string[] = []
  if (originalValue !== undefined && originalValue !== null && originalValue !== '') {
    tipParts.push(`Original: ${originalValue}${originalUnit ? ' ' + originalUnit : ''}`)
  }
  if (scaleFunction) {
    tipParts.push(`Converted via ${scaleFunction}`)
  }
  if (needsReview && !scaleFunction) {
    tipParts.push('Unit could not be auto-converted — value kept as-is')
  }
  const tip = tipParts.join(' • ')
  const label = needsReview && !scaleFunction ? 'Needs review' : `Converted via ${scaleFunction}`
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
