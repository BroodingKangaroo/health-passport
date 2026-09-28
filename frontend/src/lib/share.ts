import type {
  BiomarkerDefinition,
  BiomarkerResult,
  DateHeader,
  InstrumentalData,
  MatrixCategory,
  MedicalEvent,
  VisitData,
} from './types'
import { isOutOfRange } from './status-labels'

/**
 * Types and pure helpers for the public share surface (roadmap 1.1). The
 * payload mirrors the timeline response so the real components apply to it
 * unchanged; only `meta` and `header` are new.
 */

export const SHARE_TOKEN_HEADER = 'X-Share-Token'

/**
 * The unlock grant (Stage 4, S15). A second credential for the same request:
 * the token says WHICH link, the grant says "this reader already typed the
 * code". Held in `sessionStorage`, never a cookie — the share surface sets no
 * cookie by contract.
 */
export const SHARE_GRANT_HEADER = 'X-Share-Grant'

/** Where the grant is kept: per tab, forgotten when the tab closes. */
export const SHARE_GRANT_STORAGE_KEY = 'hp.share.grant'

export type ShareEntryType = 'blood_test' | 'doctor_visit' | 'instrumental_test' | 'procedure'

/**
 * The two views of one shared record (shared-view plan §1).
 *
 * `summary` is the short clinical read and the default; `full` is the record
 * the way its owner sees it, read-only. The choice lives in the URL — never a
 * cookie, never `localStorage` — so a recipient can bookmark it, send it on,
 * and print it, and so the server can render the right view on first paint
 * with JavaScript disabled.
 */
export type SharedView = 'summary' | 'full'

export const SHARED_VIEW_PARAM = 'view'

/** The URL's `?view=` value → the view to render. Anything unknown is the default. */
export function parseSharedView(raw: string | string[] | undefined | null): SharedView {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === 'full' ? 'full' : 'summary'
}

/**
 * A link to one view of a shared record, keeping the language choice.
 *
 * The view is written explicitly (`?view=summary` as well as `?view=full`) so
 * a URL copied out of the address bar always says which view it opens — the
 * default is decided by `parseSharedView`, not by the absence of the key.
 */
export function sharedViewHref(
  token: string,
  view: SharedView,
  lang?: string | null,
): string {
  const params = new URLSearchParams()
  if (lang) params.set('lang', lang)
  params.set(SHARED_VIEW_PARAM, view)
  return `/s/${token}?${params.toString()}`
}

/**
 * The four types a sender may exclude, in canonical order. The dialog renders
 * one checkbox each and the card reads the stored list back in words; the
 * backend refuses anything else, so this list is the vocabulary, not a
 * suggestion.
 */
export const SHARE_ENTRY_TYPES: readonly ShareEntryType[] = [
  'blood_test',
  'doctor_visit',
  'instrumental_test',
  'procedure',
] as const

/** The minimum passcode length the server enforces (S15). */
export const SHARE_PASSCODE_MIN_LENGTH = 6

/** What the shared page should render for a link, before any record is read. */
export type SharedFirstPaint = 'record' | 'protected' | 'unavailable'

/**
 * The shared page's first-paint decision (Stage 4, S15), as a pure function.
 *
 * `GET /api/share/status` answers one of three things and the page has to turn
 * it into one of three renders. Extracted from the page because a server
 * component is impractical to render in vitest, and this is the branch a real
 * browser had to catch during Stage 4 development — it should not be the one
 * piece with no test (Stage 4 review).
 */
export function sharedFirstPaint(
  status: { requires_passcode: boolean } | null,
): SharedFirstPaint {
  if (status === null) return 'unavailable'
  return status.requires_passcode ? 'protected' : 'record'
}

export interface ShareRecordMeta {
  created_at: string
  expires_at: string
  last_updated: string
  scope: ShareLinkScope
  default_locale: string | null
}

export interface ShareRecordHeader {
  name: string
  dob: string
  gender: string
}

export interface SharedRecord {
  meta: ShareRecordMeta
  header: ShareRecordHeader | null
  events: MedicalEvent[]
  biomarkers: BiomarkerResult[]
  visits: Record<string, VisitData>
  instrumental: Record<string, InstrumentalData>
}

export interface SharedFlowsheet {
  dates: DateHeader[]
  matrix: MatrixCategory[]
  biomarkers: BiomarkerResult[]
}

export interface ShareLinkSummary {
  id: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  first_opened_at: string | null
  open_count: number
  last_opened_at: string | null
  is_anonymous: boolean
  scope: ShareLinkScope
  include_header: boolean
  /** The sender's per-link language preset (S10): "en" / "ru" or null. */
  default_locale: string | null
  /** True when the link needs a passcode (S15). The code itself is gone. */
  requires_passcode: boolean
  /** Computed SERVER-side — render it, never re-derive it from the dates. */
  state: ShareLinkState
  /** Server-computed: the record gained entries after the sender acknowledged. */
  has_new_data: boolean
}

export interface ShareLinkCreated {
  id: string
  token: string
  created_at: string
  expires_at: string
  scope: ShareLinkScope
  include_header: boolean
  default_locale: string | null
  requires_passcode: boolean
}

/**
 * The window a link exposes. `all` is the whole record; a `range` narrows it
 * to whole days, and either end may be omitted (open-ended).
 */
export interface ShareLinkScope {
  kind: 'all' | 'range'
  from?: string | null
  to?: string | null
  /** Entry types this link withholds (S16). Absent when nothing is excluded. */
  exclude?: ShareEntryType[] | null
}

/** The scope posted when creating a link: `null` means the whole record. */
export interface ShareScopeRangeInput {
  kind: 'range'
  from: string | null
  to: string | null
  exclude?: ShareEntryType[]
}

/**
 * `POST /api/share/links` body. `expiry_days` is validated against the
 * principal server-side (anonymous senders may only ask for 1 or 7), which is
 * why the dialog hides 30 days for them instead of letting the request 400.
 */
export interface ShareLinkCreateInput {
  expiry_days: number
  scope: ShareScopeRangeInput | ShareScopeAllInput | null
  include_header: boolean
  /** "en" / "ru", or null so the recipient's browser decides (S10). */
  default_locale: string | null
  /** Optional passcode (S15); null/omitted means the link is open. */
  passcode?: string | null
}

/** The whole record, optionally minus some entry types (Stage 4, S16). */
export interface ShareScopeAllInput {
  kind: 'all'
  exclude?: ShareEntryType[]
}

/** `GET /api/share/notice` — a pure read, never the acknowledgement. */
export interface ShareNotice {
  active_links: number
  show: boolean
}

/** `POST /api/share/notice/ack` result. */
export interface ShareNoticeAck {
  success: boolean
  acknowledged: number
}

export type ShareLinkState = 'active' | 'expired' | 'revoked'

/**
 * The "Needs attention" set: out-of-range AND reliable. A reading the app
 * could not standardise (`needs_review`) or could not interpret at all (the
 * backend sends it with an empty status — a `см.комм.`-style remark) is never
 * presented as a confident flag. It still appears in the full table (D13).
 */
export function flaggedBiomarkers(biomarkers: BiomarkerResult[]): BiomarkerResult[] {
  return biomarkers
    .filter((b) => isOutOfRange(b.status) && !b.needs_review)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

/**
 * The readings the summary line counts: the ones the app actually evaluated.
 *
 * A reading the app could not interpret carries a status of `""` (the backend
 * neutralises it on the shared read path), and one that failed scale
 * conversion carries `needs_review`. Neither is "in range" — they are
 * unknown, and counting them in the denominator would inflate the reassurance
 * the line gives.
 */
export function evaluableBiomarkers(biomarkers: BiomarkerResult[]): BiomarkerResult[] {
  return biomarkers.filter((b) => b.status !== '' && !b.needs_review)
}

/** "N of M readings are outside the reference range" — counts, never a trend. */
export function flagCounts(biomarkers: BiomarkerResult[]): {
  outOfRange: number
  total: number
} {
  const evaluable = evaluableBiomarkers(biomarkers)
  return {
    outOfRange: evaluable.filter((b) => isOutOfRange(b.status)).length,
    total: evaluable.length,
  }
}

export interface TrendPoint {
  value: number | string | null
  date: string
  status: string
}

/**
 * The tail of a biomarker's series, oldest first, always ending on the latest
 * reading. The plan asks for "the last two or three values with direction";
 * the chart-less summary renders three, each with its own date, because a
 * chain of eight numbers with one date under it tells a reader nothing about
 * when anything happened.
 */
export function trendPoints(biomarker: BiomarkerResult, limit = 3): TrendPoint[] {
  const series: TrendPoint[] = [
    ...(biomarker.history ?? []).map((reading) => ({
      value: reading.value,
      date: reading.date,
      status: reading.status,
    })),
    { value: biomarker.value, date: biomarker.date, status: biomarker.status },
  ]
  return series.slice(-limit)
}

export type TrendDirection = 'up' | 'down' | 'flat'

/** The step from one reading to the next, or null when it is not a number. */
export function trendDirection(
  from: number | string | null,
  to: number | string | null,
): TrendDirection | null {
  const a = asNumber(from)
  const b = asNumber(to)
  if (a === null || b === null) return null
  if (b > a) return 'up'
  if (b < a) return 'down'
  return 'flat'
}

function asNumber(value: number | string | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const n = Number(value.trim())
    return value.trim() !== '' && Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Display name in the recipient's language, falling back to English and then
 * to the raw id. Reads the persisted multilingual name — the shared view must
 * never trigger a translation run.
 */
export function biomarkerName(definition: BiomarkerDefinition, locale: string): string {
  const names = definition.names ?? {}
  return names[locale] || names.en || definition.id
}

/** The link a recipient can open. The token travels as a path segment. */
export function shareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/s/${token}`
}
