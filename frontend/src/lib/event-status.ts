import type { BiomarkerResult } from './types'

/**
 * Out-of-range reading counts for one event. Matched by `entry_id` exactly
 * the way the "Abnormal results" filter matches an event: the biomarker's
 * history readings first, then its top-level reading.
 */
export interface StatusCounts {
  low: number
  high: number
  abnormal: number
}

export function statusCountsAtEvent(biomarkers: BiomarkerResult[], eventId: string): StatusCounts {
  const counts: StatusCounts = { low: 0, high: 0, abnormal: 0 }
  for (const b of biomarkers) {
    const all = [
      ...(b.history ?? []),
      { entry_id: b.entry_id, status: b.status },
    ]
    const match = all.find((r) => r.entry_id === eventId)
    if (match?.status === 'low') counts.low += 1
    else if (match?.status === 'high') counts.high += 1
    else if (match?.status === 'abnormal') counts.abnormal += 1
  }
  return counts
}

export function hasFlagged(counts: StatusCounts | undefined): boolean {
  return !!counts && (counts.low > 0 || counts.high > 0 || counts.abnormal > 0)
}

/**
 * Single source of truth for the abnormal-only filter and the per-card status
 * chips (T4), computed once per events/biomarkers change so the two cannot
 * drift.
 */
export function statusCountsByEvent(
  biomarkers: BiomarkerResult[],
  eventIds: string[],
): Map<string, StatusCounts> {
  const map = new Map<string, StatusCounts>()
  for (const id of eventIds) map.set(id, statusCountsAtEvent(biomarkers, id))
  return map
}
