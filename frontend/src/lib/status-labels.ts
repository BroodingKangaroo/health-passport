import type { Status } from './types'

/**
 * Localized labels for the backend's persisted status enum
 * (`normal | low | high | abnormal`), which some components render raw.
 * Unknown statuses fall back to the raw value.
 */
export type StatusTranslator = (key: string) => string

export function localizedStatus(status: string | null | undefined, t: StatusTranslator): string {
  if (!status) return ''
  const key = status.toLowerCase()
  if (key === 'normal' || key === 'low' || key === 'high' || key === 'abnormal') {
    return t(`statuses.${key}`)
  }
  return status
}

/**
 * Single source for status → presentation mappings (ISSUES.md #72): the
 * statusText class map and the chart color pair previously existed 3-4x and
 * had already drifted once (flowsheet normal cells used `text-foreground`
 * where every sibling used `text-status-normal`).
 */

/** Tailwind text-color class for a reading status. */
export const STATUS_TEXT_CLASS: Record<Status, string> = {
  normal: 'text-status-normal',
  low: 'text-status-low',
  high: 'text-status-high',
  abnormal: 'text-status-high',
}

/** Chart colors for out-of-range vs in-range points/lines. */
export const STATUS_COLORS = {
  abnormal: '#ef4444',
  normal: '#3b82f6',
} as const

/** Color for a chart point with the given reading status. */
export function statusColor(status: string | undefined | null): string {
  return status && status !== 'normal' ? STATUS_COLORS.abnormal : STATUS_COLORS.normal
}
