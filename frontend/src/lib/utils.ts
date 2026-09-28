import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Locale-aware connector between a date and its time ("Jan 15, 2027 at 09:00"
 * / "15 янв. 2026 г. в 09:00"). Shared by formatDate and splitDateLabel so the
 * format and the reverse-parse stay in sync.
 */
export function dateConnector(locale: string): string {
  return locale.toLowerCase().startsWith('ru') ? ' в ' : ' at '
}

export function formatDate(iso: string, locale = 'en-US'): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const base = d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })
  if (d.getHours() !== 0 || d.getMinutes() !== 0) {
    return `${base}${dateConnector(locale)}${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }
  return base
}

/**
 * A reading's date exactly as the document recorded it, in the reader's
 * locale — never shifted by the reader's own clock.
 *
 * Reading dates are WALL-CLOCK values from the source document: the backend
 * stores them without an offset ("2026-09-17T00:00:00"), and a midnight is a
 * calendar date, not an instant. `new Date()` reads such a string in the
 * reader's own zone and `formatDate` renders it back in that same zone, so it
 * round-trips by luck; this helper renders in UTC instead, which for a bare
 * string would move a midnight reading to the PREVIOUS DAY for a reader east
 * of UTC ("Sep 16, 2026 at 21:00" for a 17 September sample).
 *
 * So a string with no offset is anchored to UTC before parsing — it is
 * wall-clock text, and the calendar date and printed time must survive intact
 * for every reader. A string that DOES carry an offset is a real instant and
 * is left alone.
 *
 * `formatDate` is still the right helper for instants the app itself produced
 * (when the record was last updated, when a link expires), where the reader's
 * own clock is what makes the value meaningful.
 */
export function formatDay(iso: string, locale = 'en-US'): string {
  const d = new Date(anchorOffsetlessToUtc(iso))
  if (isNaN(d.getTime())) return iso
  const base = d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const hours = d.getUTCHours()
  const minutes = d.getUTCMinutes()
  if (hours !== 0 || minutes !== 0) {
    return `${base}${dateConnector(locale)}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
  }
  return base
}

/**
 * "2026-09-17T00:00:00" → "2026-09-17T00:00:00Z"; anything already carrying
 * `Z` or a numeric offset is returned unchanged. Date-only strings
 * ("1997-10-20") are already parsed as UTC by the spec, so they are left too.
 */
function anchorOffsetlessToUtc(iso: string): string {
  const trimmed = iso.trim()
  if (!trimmed.includes('T')) return trimmed
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed) ? trimmed : `${trimmed}Z`
}

/**
 * A stored date of birth ("1990-01-01") in the reader's locale.
 *
 * Split across two surfaces before this existed — the header bar had its own
 * copy and the shared record printed the raw ISO string, which is how a
 * recipient could see "1997-10-20" while every other date on the page was
 * spelled out. One helper, hoisted here so both read the same way.
 * `timeZone: 'UTC'` is deliberate: the value is a calendar date with no time,
 * so it must not shift by a day for a reader west of UTC.
 */
export function formatDob(dob: string | undefined, locale: string): string {
  if (!dob) return ''
  const d = new Date(dob)
  if (isNaN(d.getTime())) return dob
  return d.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

const COMPACT_UNITS = [
  { value: 1e12, suffix: 'T' },
  { value: 1e9, suffix: 'B' },
  { value: 1e6, suffix: 'M' },
  { value: 1e3, suffix: 'K' },
] as const

/**
 * Format a number using compact notation when it's large, so e.g.
 * `1_000_000_000` renders as `"1B"` instead of `"1000000000"` and fits in a
 * narrow flowsheet / Latest column. Small values (< 1000 in magnitude) and
 * qualitative / non-numeric strings are returned unchanged so the original
 * text (e.g. `"Not detected"`, `"—"`, `8.75`) is preserved.
 *
 *   0             -> "0"
 *   8.75          -> "8.75"
 *   123           -> "123"
 *   1234          -> "1.23K"
 *   90000000      -> "90M"
 *   1000000000    -> "1B"
 *   10000000000   -> "10B"
 *   "Not detected"-> "Not detected"
 *   null / ""     -> ""
 */
export function formatNumber(
  value: number | string | null | undefined,
): string {
  if (value == null || value === '') return ''
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs < 1000) {
    return _stripTrailingZeros(n.toString())
  }
  for (const { value: unit, suffix } of COMPACT_UNITS) {
    if (abs >= unit) {
      const scaled = n / unit
      // Pick decimals by magnitude so 1B → "1B" and 1.23B → "1.23B".
      const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
      return _stripTrailingZeros(scaled.toFixed(decimals)) + suffix
    }
  }
  return _stripTrailingZeros(n.toString())
}

function _stripTrailingZeros(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/\.?0+$/, '')
}

/**
 * Full-precision number formatting for official exports (print editor). Unlike
 * `formatNumber`, large magnitudes are NOT compacted into K/M/B/T suffixes;
 * thousands separators are added for readability, so a lab value such as
 * 1250000 prints as "1,250,000" — never "1.25M".
 *
 *   0             -> "0"
 *   8.75          -> "8.75"
 *   1234          -> "1,234"
 *   1250000       -> "1,250,000"
 *   -1234567.5    -> "-1,234,567.5"
 *   "Not detected"-> "Not detected"
 *   null / ""     -> ""
 */
export function formatNumberFull(
  value: number | string | null | undefined,
): string {
  if (value == null || value === '') return ''
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (n === 0) return '0'
  return _groupIntegerPart(_stripTrailingZeros(n.toString()))
}

function _groupIntegerPart(s: string): string {
  const dot = s.indexOf('.')
  const int = dot === -1 ? s : s.slice(0, dot)
  const rest = dot === -1 ? '' : s.slice(dot)
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + rest
}

/**
 * Epoch milliseconds for a reading's ISO `date`, with a finite fallback (0)
 * for unparseable strings. The single parse source for sorting and the chart
 * time axis, so array order and numeric x positions cannot diverge.
 */
export function readingEpoch(date: string): number {
  return Date.parse(date) || 0
}

/**
 * Sort readings oldest → newest by their ISO `date`. Stable: equal or
 * unparseable timestamps keep their original relative order (unparseable sort
 * first). Returns a new array; the input is not mutated. Recharts plots chart
 * points in array order, so every chart series must pass through this —
 * TimelineView.biomarkersAtDate promotes a non-latest event's reading to the
 * "current" slot, which otherwise lands after newer history readings.
 */
export function sortReadingsByDate<T extends { date: string }>(
  readings: readonly T[],
): T[] {
  return readings
    .map((reading, index) => ({ reading, index, time: readingEpoch(reading.date) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map((entry) => entry.reading)
}

export function splitDateLabel(
  dateStr: string,
  locale = 'en-US',
): { label: string; sub?: string } {
  const d = new Date(dateStr)
  if (!isNaN(d.getTime())) {
    const base = d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })
    if (d.getHours() !== 0 || d.getMinutes() !== 0) {
      return {
        label: base,
        sub: `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
      }
    }
    return { label: base }
  }
  // Reverse-parse a previously formatted label ("… at 09:00" / "… в 09:00").
  const conn = dateConnector(locale)
  const idx = dateStr.lastIndexOf(conn)
  if (idx === -1) return { label: dateStr }
  return { label: dateStr.slice(0, idx).trimEnd(), sub: dateStr.slice(idx + conn.length).trim() }
}
