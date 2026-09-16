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
  is_anonymous: boolean
  scope: { kind: string }
  include_header: boolean
  include_notes: boolean
}

export interface ShareLinkCreated {
  id: string
  token: string
  created_at: string
  expires_at: string
  scope: { kind: string }
  include_header: boolean
  include_notes: boolean
}

export type ShareLinkState = 'active' | 'expired' | 'revoked'

/** The three states the sender must be able to tell apart at a glance. */
export function shareLinkState(
  link: Pick<ShareLinkSummary, 'revoked_at' | 'expires_at'>,
  now = Date.now(),
): ShareLinkState {
  if (link.revoked_at) return 'revoked'
  if (new Date(link.expires_at).getTime() <= now) return 'expired'
  return 'active'
}

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
