import type { Reference, ReferenceInterval, ReferenceQualitative, BiomarkerDefinition } from './types'
import { formatNumber, formatNumberFull } from './utils'

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
 *   {kind:'interval', low:null, high:null}, 'mg' -> '—'
 *   {kind:'qualitative', expected:'Negative'} -> 'Negative'
 *   {kind:'qualitative', expected:'Negative'}, 'copies/mL' -> 'Negative'
 *   {kind:'qualitative', expected:'отсутствуют'} -> 'отсутствуют'
 *   {kind:'qualitative', expected:null}       -> '—'
 *   null                                       -> '—'
 *
 * Qualitative references never take a unit suffix (the expected text IS the
 * reference — appending one would read "Not detected copies/mL"), and an
 * interval without bounds renders as bare '—' with no unit.
 *
 * Pass `{ full: true }` for official exports (print editor): bounds render at
 * full precision with thousands separators (e.g. `1,250,000`) instead of
 * compact form (`1.25M`).
 */
export function formatReference(
  ref: Reference | null | undefined,
  unit?: string | null,
  opts?: { full?: boolean },
): string {
  if (!ref) return '—'
  if (ref.kind === 'interval') {
    return formatInterval(ref, unit, opts?.full ?? false)
  }
  // qualitative: the expected text IS the reference — no unit suffix.
  const q = ref as ReferenceQualitative
  return q.expected && q.expected.trim() ? q.expected.trim() : '—'
}

function formatInterval(ref: ReferenceInterval, unit?: string | null, full = false): string {
  const fmt = (n: number | null) =>
    n == null ? '' : full ? formatNumberFull(n) : formatNumber(n)
  const { low, high } = ref
  if (low == null && high == null) return '—'
  let body: string
  if (low != null && high != null) {
    body = `${fmt(low)} – ${fmt(high)}`
  } else if (low != null) {
    body = `≥ ${fmt(low)}`
  } else {
    body = `≤ ${fmt(high)}`
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

/**
 * Return the display unit for a biomarker definition: the canonical
 * (English) unit when the matcher has set one, otherwise the raw
 * ``unit`` field as a fallback. Older / global LOINC defs that don't
 * have ``canonical_unit`` populated will simply return ``unit``.
 */
export function displayUnit(
  definition: Pick<BiomarkerDefinition, 'canonical_unit' | 'unit'>,
): string {
  return definition.canonical_unit || definition.unit || ''
}