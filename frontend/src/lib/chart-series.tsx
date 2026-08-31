import type { XAxisTickContentProps } from 'recharts'

import { intervalBounds, isQualitative, qualitativeToNumber } from './reference'
import { splitDateLabel } from './utils'
import type { Reference } from './types'

/**
 * Shared chart-series helpers (ISSUES.md #71): value coercion, reference-band
 * derivation, and the two-line date tick renderer were previously implemented
 * 2-3x across BiomarkerChartInner, flowsheet-matrix, and correlation-chart.
 */

/**
 * Coerce a reading value into a plottable number. Finite numbers pass
 * through; for a QUALITATIVE reference the canonical qualitative strings map
 * to 0/1 (qualitativeToNumber); anything else is not plottable (null).
 */
export function coerceChartValue(
  value: string | number | null | undefined,
  qualitative: boolean,
): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!qualitative) return null
  return qualitativeToNumber(value)
}

/**
 * Reference-band bounds for a chart: a qualitative reference spans the
 * 0..1 axis used by qualitativeToNumber; an interval reference yields its
 * own bounds; null otherwise.
 */
export function chartReferenceBounds(
  ref: Reference | null | undefined,
): { low: number | null; high: number | null } | null {
  return isQualitative(ref) ? { low: 0, high: 1 } : intervalBounds(ref)
}

/**
 * Two-line date tick renderer for recharts XAxis: the main date label plus a
 * smaller sub-label (time) beneath it. `compact` shrinks the fonts/offsets
 * for the small sparkline-style charts.
 */
export function dateTickRenderer(locale: string, opts?: { compact?: boolean }) {
  const compact = opts?.compact ?? false
  // Named function declaration so the React lint rule sees a display name.
  function DateTick(tickProps: XAxisTickContentProps) {
    const { label, sub } = splitDateLabel(String(tickProps.payload.value), locale)
    const fs = compact ? 9 : 11
    const subFs = compact ? 8 : 9
    const dy1 = compact ? 10 : 12
    const dy2 = compact ? 20 : 24
    return (
      <g transform={`translate(${tickProps.x},${tickProps.y})`}>
        <text x={0} y={0} dy={dy1} textAnchor="middle" fill="#71717a" fontSize={fs}>
          {label}
        </text>
        {sub && (
          <text x={0} y={0} dy={dy2} textAnchor="middle" fill="#a1a1aa" fontSize={subFs}>
            {sub}
          </text>
        )}
      </g>
    )
  }
  return DateTick
}
