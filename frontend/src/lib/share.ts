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

export interface ShareRecordMeta {
  created_at: string
  expires_at: string
  last_updated: string
  scope: { kind: string; from?: string; to?: string }
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
}

/**
 * The window a link exposes. `all` is the whole record; a `range` narrows it
 * to whole days, and either end may be omitted (open-ended).
 */
export interface ShareLinkScope {
  kind: 'all' | 'range'
  from?: string | null
  to?: string | null
}

/** The scope posted when creating a link: `null` means the whole record. */
export interface ShareScopeRangeInput {
  kind: 'range'
  from: string | null
  to: string | null
}

/**
 * `POST /api/share/links` body. `expiry_days` is validated against the
 * principal server-side (anonymous senders may only ask for 1 or 7), which is
 * why the dialog hides 30 days for them instead of letting the request 400.
 */
export interface ShareLinkCreateInput {
  expiry_days: number
  scope: ShareScopeRangeInput | null
  include_header: boolean
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
 * could not standardise (`needs_review`) is never presented as a confident
 * flag — it still appears in the full table (D13).
 */
export function flaggedBiomarkers(biomarkers: BiomarkerResult[]): BiomarkerResult[] {
  return biomarkers
    .filter((b) => isOutOfRange(b.status) && !b.needs_review)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
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
