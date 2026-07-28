import type { Reference, ReferenceInterval, ReferenceQualitative } from './types'
import { formatNumber } from './utils'

/** Canonical qualitative values matching the backend's normalisation enum. */
export const QUALITATIVE_VALUES = [
  'Negative',
  'Positive',
  'Detected',
  'Not detected',
  'Absent',
  'Present',
  'Normal',
  'Abnormal',
] as const

/**
 * Format a structured reference for display. Numeric results carry an optional
 * unit suffix; qualitative references render their expected text (or '—').
 * Large interval bounds (>= 1000) are rendered in compact form
 * (e.g. `1.5B` instead of `1500000000`) so the value column doesn't overflow.
 *
 *   {kind:'interval', low:4, high:11}        -> '4 – 11'
 *   {kind:'interval', low:1e9, high:1e10}    -> '1B – 10B'
 *   {kind:'interval', low:null, high:1e11}   -> '≤ 100B'
 *   {kind:'interval', low:4, high:11}, 'mg'  -> '4 – 11 mg'
 *   {kind:'qualitative', expected:'Negative'} -> 'Negative'
 *   {kind:'qualitative', expected:'отсутствуют'} -> 'отсутствуют'
 *   {kind:'qualitative', expected:null}       -> '—'
 *   null                                       -> '—'
 */
export function formatReference(ref: Reference | null | undefined, unit?: string | null): string {
  if (!ref) return '—'
  if (ref.kind === 'interval') {
    return formatInterval(ref, unit)
  }
  // qualitative
  const q = ref as ReferenceQualitative
  const text = q.expected && q.expected.trim() ? q.expected.trim() : '—'
  return unit ? `${text} ${unit}`.trim() : text
}

function formatInterval(ref: ReferenceInterval, unit?: string | null): string {
  const { low, high } = ref
  let body: string
  if (low != null && high != null) {
    body = `${formatNumber(low)} – ${formatNumber(high)}`
  } else if (low != null) {
    body = `≥ ${formatNumber(low)}`
  } else if (high != null) {
    body = `≤ ${formatNumber(high)}`
  } else {
    body = '—'
  }
  return unit ? `${body} ${unit}`.trim() : body
}

/** Extract numeric bounds when the reference is an interval; null otherwise. */
export function intervalBounds(ref: Reference | null | undefined): { low: number | null; high: number | null } | null {
  if (!ref || ref.kind !== 'interval') return null
  const i = ref as ReferenceInterval
  return { low: i.low, high: i.high }
}

/** True when the value falls outside (or fails to match) the reference. */
export function isOutsideReference(value: string | number | null | undefined, ref: Reference | null | undefined): boolean {
  if (!ref || value == null) return false
  if (ref.kind === 'interval') {
    const v = typeof value === 'number' ? value : Number.parseFloat(String(value))
    if (!Number.isFinite(v)) return false
    const i = ref as ReferenceInterval
    if (i.low != null && v < i.low) return true
    if (i.high != null && v > i.high) return true
    return false
  }
  // qualitative: outside means the value differs from the expected text
  if (!ref.expected) return false
  const actual = String(value).trim().toLowerCase()
  const expected = String(ref.expected).trim().toLowerCase()
  return actual !== expected
}

/** Is this reference a qualitative (text) one? */
export function isQualitative(ref: Reference | null | undefined): boolean {
  return !!ref && ref.kind === 'qualitative'
}

/** The label for a unit column: "Qualitative" when the reference is qualitative. */
export function unitLabel(unit: string, ref: Reference | null | undefined): string {
  return isQualitative(ref) ? 'Qualitative' : unit
}

/** Map a qualitative value to a number for charting: absence → 0, presence → 1. */
export function qualitativeToNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const v = String(value).trim()
  if (_ABSENT.has(v)) return 0
  if (_PRESENT.has(v)) return 1
  const l = v.toLowerCase()
  if (_ABSENT_LOWER.has(l)) return 0
  if (_PRESENT_LOWER.has(l)) return 1
  return null
}

const _ABSENT = new Set(['Absent', 'Not detected', 'Negative', 'Normal'])
const _PRESENT = new Set(['Present', 'Detected', 'Positive', 'Abnormal'])
const _ABSENT_LOWER = new Set([..._ABSENT].map((v) => v.toLowerCase()))
const _PRESENT_LOWER = new Set([..._PRESENT].map((v) => v.toLowerCase()))

/** Build an interval reference, or null when both bounds are null. */
export function intervalReference(low: number | null, high: number | null): ReferenceInterval | null {
  if (low == null && high == null) return null
  return { kind: 'interval', low, high }
}