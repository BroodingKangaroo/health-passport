import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { getAccessToken } from '@/lib/auth-token'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Fetch a protected document (e.g. /static/uploads/...) with the auth token and
 * return a same-origin object URL. The raw URL cannot be used directly by an
 * <img>/<iframe>/<a download> because those requests can't send the
 * Authorization header, so the backend rejects them as anonymous (403).
 */
export async function fetchAuthedObjectUrl(url: string): Promise<string> {
  const token = getAccessToken()
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {}
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Failed to load document: ${res.status}`)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

const IMAGE_RE = /\.(jpg|jpeg|png|gif|webp|tiff|tif|bmp)$/i

/**
 * Print a protected document. Fetches it with the auth token, then opens the
 * browser print dialog for it. Images are wrapped in a minimal HTML page with
 * print styles so the picture fits on a single page (otherwise the browser
 * prints the raw <img> at natural size, splitting it across pages). Cleanup
 * happens on `afterprint` (when the dialog is dismissed) rather than on a
 * timer, so the print dialog is never yanked out from under the user.
 */
export async function printAuthedDocument(url: string): Promise<void> {
  const token = getAccessToken()
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {}
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Failed to load document: ${res.status}`)
  const blob = await res.blob()
  const isImage = IMAGE_RE.test(url) || blob.type.startsWith('image/')

  let src: string
  let cleanup: () => void
  if (isImage) {
    const imgUrl = URL.createObjectURL(blob)
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { margin: 0; }
      html, body { margin: 0; padding: 0; height: 100%; }
      img { display: block; margin: 0 auto; max-width: 100%; max-height: 100vh; width: auto; height: auto; object-fit: contain; page-break-inside: avoid; }
    </style></head><body><img src="${imgUrl}"></body></html>`
    src = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    cleanup = () => {
      URL.revokeObjectURL(src)
      URL.revokeObjectURL(imgUrl)
    }
  } else {
    src = URL.createObjectURL(blob)
    cleanup = () => URL.revokeObjectURL(src)
  }

  const iframe = document.createElement('iframe')
  iframe.style.position = 'absolute'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)
  iframe.onload = () => {
    const w = iframe.contentWindow
    if (!w) return
    w.onafterprint = cleanup
    try { w.focus() } catch {}
    try { w.print() } catch {}
  }
  iframe.src = src
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
    .map((reading, index) => ({ reading, index, time: Date.parse(reading.date) || 0 }))
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
