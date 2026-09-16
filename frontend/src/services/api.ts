import type {
  TimelineResponse,
  FlowsheetResponse,
  BiomarkerResult,
  BiomarkerDefinition,
  SaveEntryResponse,
  StandardizedMedicalRecord,
  ProgressEventPayload,
  EntriesByDateResponse,
  ExtractedVisitData,
  ExtractedInstrumentalData,
  FormCategory,
  DeleteEntryResponse,
  DeleteAccountResponse,
  UsageLimits,
  CurrentUser,
  TranslateLang,
} from '@/lib/types'

// Re-exported for callers that historically imported these from the api module.
export type {
  DeleteEntryResponse,
  DeleteAccountResponse,
  UsageLimits,
  CurrentUser,
} from '@/lib/types'
import { getAccessToken } from '@/lib/auth-token'
import { apiFallback, getApiLocale } from '@/i18n/api-locale'
import type { ShareLinkCreated, ShareLinkSummary } from '@/lib/share'

const API_BASE = process.env.NEXT_PUBLIC_API_URL
  ? `${process.env.NEXT_PUBLIC_API_URL}/api`
  : '/api'

/**
 * Headers sent with every API call. Besides the auth token, the chosen UI
 * locale goes out as Accept-Language so the backend localizes its error
 * `detail` strings (see backend/app/i18n.py).
 */
function baseHeaders(): Record<string, string> {
  return {
    'Accept-Language': getApiLocale(),
    ...authHeaders(),
  }
}

// SSE/streaming endpoints route through the same Next.js rewrite proxy as every
// other API call (STATIC_PROXY_URL). The proxy streams SSE through unchanged —
// verified incrementally on Next 16 (dev Turbopack and production standalone) —
// so progress events are not buffered. Setting NEXT_PUBLIC_API_URL keeps an
// escape hatch to talk to a backend origin directly (requires CORS_ORIGINS on
// the backend to include this site).
function streamApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return `${process.env.NEXT_PUBLIC_API_URL}/api`
  return '/api'
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export class UsageLimitError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'UsageLimitError'
  }
}

/**
 * Global re-auth hook. A 401 on a request that CARRIED a bearer token means
 * the backend no longer accepts that token: either it expired, or the account
 * bumped its session version (password change, password reset, confirmed
 * email change) and this copy is stale. NextAuth's local session can outlive
 * the backend token, so the user would otherwise stay "signed in" on a page
 * that keeps failing. AuthStatusProvider registers the handler once and
 * clears the NextAuth session, landing the user on /login.
 */
let _onUnauthorized: (() => void) | null = null
// The token that already triggered a sign-out, so a burst of 401s from
// parallel queries (and react-query's retries) reaches the handler once.
let _unauthorizedToken: string | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  _onUnauthorized = handler
  if (!handler) _unauthorizedToken = null
}

/** Fire the re-auth hook at most once per bearer token. */
export function notifyUnauthorized(): void {
  const token = getAccessToken()
  if (!token || _unauthorizedToken === token) return
  _unauthorizedToken = token
  _onUnauthorized?.()
}

/**
 * Build the ApiError for a failed response, first firing the re-auth hook for
 * a 401. Every fetch wrapper in this module (and in `import-jobs` /
 * `notifications`) goes through here so a dead token is handled identically
 * everywhere instead of only on the mount-time /auth/me probe.
 */
export async function apiError(res: Response, fallback: string): Promise<ApiError> {
  if (res.status === 401) notifyUnauthorized()
  const body = await res.json().catch(() => null)
  return new ApiError(res.status, extractDetail(body, fallback))
}

function authHeaders(): Record<string, string> {
  const token = getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Extract a human-readable message from an error-response body. FastAPI
 * returns `detail` as a string on HTTPException but as an ARRAY of
 * validation-error objects on 422 — those must become readable text, never
 * "[object Object]".
 *
 * Exported for sibling service modules (import-jobs, notifications) so the
 * localized-`detail` extraction stays in one place.
 */
export function extractDetail(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const e = item as { msg?: unknown; loc?: unknown }
          const msg = typeof e.msg === 'string' ? e.msg : ''
          const loc = Array.isArray(e.loc) ? e.loc.join('.') : ''
          if (msg && loc) return `${loc}: ${msg}`
          return msg || JSON.stringify(item)
        }
        return String(item)
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('; ')
  }
  return fallback
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) {
    // Same localized-detail extraction as every POST/DELETE path (ISSUES.md
    // #66): the backend's localized `detail` must reach the UI, not a
    // generic status text.
    throw await apiError(res, `GET ${path} failed: ${res.statusText}`)
  }
  return res.json()
}

/* ----- Timeline ----- */
export async function fetchTimelineEvents(): Promise<TimelineResponse> {
  return apiGet<TimelineResponse>('/timeline')
}

/* ----- Flowsheet ----- */
export async function fetchFlowsheetData(
  opts?: { signal?: AbortSignal },
): Promise<FlowsheetResponse> {
  const res = await fetch(`${API_BASE}/flowsheet`, {
    cache: 'no-store',
    headers: { ...baseHeaders() },
    credentials: 'include',
    signal: opts?.signal,
  })
  if (!res.ok) throw await apiError(res, 'GET /flowsheet failed')
  return res.json()
}

/* ----- Biomarker Detail ----- */
export async function fetchBiomarkerDetail(id: string): Promise<BiomarkerResult> {
  return apiGet<BiomarkerResult>(`/biomarker/${id}`)
}

/* ----- Entries by Date ----- */
export async function fetchEntriesByDate(
  date: string,
  type?: string,
  opts?: { signal?: AbortSignal },
): Promise<EntriesByDateResponse> {
  const params = `date=${date}${type ? `&type=${type}` : ''}`
  const res = await fetch(`${API_BASE}/entries/by-date?${params}`, {
    headers: { ...baseHeaders() },
    credentials: 'include',
    // Abortable (ISSUES.md #67): callers with AbortControllers (e.g. the
    // merge preflight debounce) can cancel stale in-flight requests.
    signal: opts?.signal,
  })
  if (!res.ok) {
    throw await apiError(res, `GET /entries/by-date failed: ${res.statusText}`)
  }
  return res.json()
}

/* ----- Biomarker Definitions ----- */
export async function fetchBiomarkerDefinitions(): Promise<BiomarkerDefinition[]> {
  return apiGet<BiomarkerDefinition[]>('/biomarkers/definitions')
}

/* ----- Biomarker name translation (print/export) ----- */
export interface TranslateNameItem {
  id: string
  name: string
}

export type TranslationSource = 'translated' | 'cached' | 'fallback'

export interface TranslatedName {
  name: string
  source: TranslationSource
}

// A category/panel heading translation. Never persisted server-side — the
// map lives in the print config (sessionStorage) for this document only.
export type CategoryTranslations = Record<string, string>

// A hung Mistral request must not leave the Generate button stuck forever;
// Generous budget: the Mistral call can legitimately take well over a minute
// under load (observed ~90s), and the backend short-circuits already-translated
// names, so a retry after a timeout is cheap. We still cap it so the UI can't
// hang forever.
const TRANSLATE_TIMEOUT_MS = 150_000

/**
 * Translate biomarker definition names into a target language. By default the
 * backend persists translations into each definition's `names[lang]` (free
 * short-circuit for already-translated names). With `{ persist: false }`
 * (review flow) nothing is written — confirm via `commitTranslatedNames`.
 * An external `signal` aborts the in-flight request (leave-guard). Returns
 * an id -> {name, source} map; `source` distinguishes newly translated names
 * from cached ones and silent English fallbacks.
 *
 * `opts.categories` are category/panel heading strings translated in the same
 * LLM batch; they are never persisted server-side and come back keyed by
 * their exact input string (missing entries = English fallback).
 */
export async function translateBiomarkerNames(
  lang: TranslateLang,
  names: TranslateNameItem[],
  opts?: { persist?: boolean; signal?: AbortSignal; categories?: string[] },
): Promise<{ names: Map<string, TranslatedName>; categories: CategoryTranslations }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, TRANSLATE_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  opts?.signal?.addEventListener('abort', onExternalAbort)
  try {
    const res = await fetch(`${API_BASE}/translate-biomarkers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...baseHeaders() },
      credentials: 'include',
      body: JSON.stringify({
        lang,
        names,
        categories: opts?.categories ?? [],
        persist: opts?.persist ?? true,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      if (res.status === 429) {
        const body = await res.json().catch(() => null)
        throw new UsageLimitError(res.status, extractDetail(body, apiFallback('usageLimitReached')))
      }
      throw await apiError(res, apiFallback('postTranslateFailed'))
    }
    const data = (await res.json()) as {
      translations: (TranslateNameItem & { source?: TranslationSource })[]
      categories?: { original: string; translated: string }[]
    }
    const nameMap = new Map(
      (data.translations || []).map((t) => [
        t.id,
        { name: t.name, source: t.source ?? 'fallback' },
      ]),
    )
    const categoryMap: CategoryTranslations = {}
    for (const c of data.categories || []) {
      categoryMap[c.original] = c.translated
    }
    return { names: nameMap, categories: categoryMap }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Only the TIMEOUT abort becomes a timeout error; an external abort
      // (leave-guard) re-throws so the UI doesn't show a bogus timeout
      // toast when the user simply navigated away (ISSUES.md #75).
      if (!timedOut) throw err
      throw new Error(apiFallback('translationTimedOut'))
    }
    throw err
  } finally {
    clearTimeout(timer)
    opts?.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Persist the translations the user accepted in the review dialog. No LLM
 * call and no quota — the LLM already ran in the preceding
 * `translateBiomarkerNames(..., { persist: false })` request. Returns the
 * number of definitions written.
 */
export async function commitTranslatedNames(
  lang: TranslateLang,
  items: TranslateNameItem[],
): Promise<number> {
  const res = await fetch(`${API_BASE}/translate-biomarkers/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...baseHeaders() },
    credentials: 'include',
    body: JSON.stringify({ lang, items }),
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('postTranslateCommitFailed'))
  }
  const data = (await res.json()) as { saved?: number }
  return data.saved ?? 0
}

/* ----- AI Extraction (SSE stream) ----- */
export async function extractMedicalData(
  file: File,
  onProgress?: (payload: ProgressEventPayload) => void,
  signal?: AbortSignal,
): Promise<StandardizedMedicalRecord> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${streamApiBase()}/extract`, {
    method: 'POST',
    body: fd,
    headers: { ...baseHeaders() },
    credentials: 'include',
    signal,
  })
  if (!res.ok) {
    if (res.status === 429) {
      const body = await res.json().catch(() => null)
      throw new UsageLimitError(res.status, extractDetail(body, apiFallback('usageLimitReached')))
    }
    throw await apiError(res, apiFallback('postExtractFailed'))
  }

  if (!res.body) throw new Error('Response body is missing — cannot read extraction stream')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventType = ''
  let data = ''
  let result: StandardizedMedicalRecord | null = null

  // Watchdog: the backend streams SSE events, but if the connection dies
  // mid-stream (proxy drop, backend cancelled by a client disconnect) the
  // stream can go silent forever — no result, no error, no end-of-stream. A
  // stalled fetch would leave the UI frozen on the "estimating..." scan
  // screen indefinitely, so if no bytes arrive within the window we cancel
  // the stream and surface a timeout error the caller can act on. The backend
  // sends keep-alive comments during its long silent phases, so this only
  // fires on a genuinely dead/stalled connection, never during normal slow
  // extraction.
  const WATCHDOG_MS = 90_000
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      timedOut = true
      reader.cancel().catch(() => {})
    }, WATCHDOG_MS)
  }
  const timeoutError = () => new Error(apiFallback('extractionTimedOut'))

  function processLine(line: string) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7)
    } else if (line.startsWith('data: ')) {
      data += line.slice(6) + '\n'
    } else if (line === '') {
      // Empty line = end of event
      if (eventType === 'progress') {
        try {
          const parsed = JSON.parse(data.trim())
          onProgress?.(parsed as ProgressEventPayload)
        } catch {
          // Ignore malformed progress payloads — they are advisory only.
        }
      } else if (eventType === 'result') {
        try {
          result = JSON.parse(data.trim()) as StandardizedMedicalRecord
        } catch {
          throw new Error('Failed to parse extraction result payload')
        }
      } else if (eventType === 'error') {
        let message = apiFallback('extractionFailed')
        try {
          message = JSON.parse(data.trim()).message || message
        } catch {
          const raw = data.trim()
          if (raw) message = raw
        }
        throw new Error(message)
      }
      eventType = ''
      data = ''
    }
  }

  try {
    armWatchdog()
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Extraction aborted', 'AbortError')
      }
      // A watchdog-fired reader.cancel() may surface as either a done read or
      // an AbortError; both must become a timeout error (a plain Error so the
      // caller doesn't mistake it for a superseded-extraction abort).
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        if (timedOut) throw timeoutError()
        throw new DOMException('Extraction aborted', 'AbortError')
      }
      if (chunk.done) {
        if (timedOut) throw timeoutError()
        break
      }
      armWatchdog()
      buffer += decoder.decode(chunk.value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        processLine(line)
      }
      if (result) return result
    }

    // Process any remaining buffer
    if (buffer) {
      processLine(buffer)
      if (eventType) {
        processLine('')
      }
    }

    if (result) return result
    throw new Error('Stream ended without result event')
  } finally {
    if (watchdog) clearTimeout(watchdog)
    // Always release the reader so the underlying HTTP stream is closed,
    // even on error/abort. Safe to call after natural completion.
    try {
      await reader.cancel()
    } catch {
      // ignore — reader may already be closed
    }
  }
}

/* ----- Save Entry ----- */
export interface SaveEntryFormData {
  type: string
  date: string
  time: string
  clinic: string
  provider: string
  title: string
  notes: string
  // Detected source-document language relayed from the /api/extract result;
  // empty string = unknown (manual entry). The backend validates against its
  // allowlist and stores NULL otherwise.
  source_language?: string
  biomarkers: FormCategory[]
  visit_data?: ExtractedVisitData | null
  instrumental_data?: ExtractedInstrumentalData | null
  file?: File | null
}

/**
 * Build the multipart FormData shared by POST /entry and /entry/{id}/merge.
 * Kept here so the exact wire shape lives next to the endpoints that consume it.
 */
export function buildSaveEntryFormData(f: SaveEntryFormData): FormData {
  const fd = new FormData()
  fd.append('type', f.type)
  fd.append('date', f.date)
  fd.append('time', f.time)
  fd.append('clinic', f.clinic)
  fd.append('provider', f.provider)
  fd.append('title', f.title)
  fd.append('notes', f.notes)
  if (f.source_language) {
    fd.append('source_language', f.source_language)
  }
  fd.append('biomarkers', JSON.stringify(f.biomarkers))
  if (f.visit_data) {
    fd.append('visit_data', JSON.stringify(f.visit_data))
  }
  if (f.instrumental_data) {
    fd.append('instrumental_data', JSON.stringify(f.instrumental_data))
  }
  if (f.file) {
    fd.append('file', f.file)
  }
  return fd
}

/**
 * Hard-timeout wrapper for the save/merge/delete paths (ISSUES.md #75): the
 * extract/translate paths already cap their calls; these previously had none,
 * so a hung connection left Save/Delete buttons stuck forever. An external
 * abort (leave-guard) is forwarded; a TIMEOUT abort becomes a readable
 * ApiError instead of a raw AbortError.
 */
const SAVE_TIMEOUT_MS = 30_000

async function fetchWithTimeout(path: string, init: RequestInit, timeoutMs = SAVE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onExternalAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onExternalAbort)
  try {
    return await fetch(path, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError' && timedOut) {
      throw new ApiError(0, apiFallback('requestTimedOut'))
    }
    throw err
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onExternalAbort)
  }
}

export async function saveMedicalEntry(formData: FormData): Promise<SaveEntryResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/entry`, {
    method: 'POST',
    body: formData,
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) {
    if (res.status === 429) {
      const body = await res.json().catch(() => null)
      throw new UsageLimitError(res.status, extractDetail(body, apiFallback('usageLimitReached')))
    }
    throw await apiError(res, apiFallback('postEntryFailed'))
  }
  return res.json()
}

/* ----- Merge into existing entry ----- */
export async function mergeMedicalEntry(
  entryId: string,
  formData: FormData,
): Promise<SaveEntryResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/entry/${encodeURIComponent(entryId)}/merge`, {
    method: 'POST',
    body: formData,
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) {
    if (res.status === 429) {
      const body = await res.json().catch(() => null)
      throw new UsageLimitError(res.status, extractDetail(body, apiFallback('usageLimitReached')))
    }
    throw await apiError(res, apiFallback('postEntryMergeFailed'))
  }
  return res.json()
}

/* ----- Delete Entry ----- */
export async function deleteEntry(id: string): Promise<DeleteEntryResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/entry/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('deleteEntryFailed'))
  }
  return res.json() as Promise<DeleteEntryResponse>
}

/* ----- Account & Data (settings) ----- */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...baseHeaders() },
    credentials: 'include',
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('changePasswordFailed'))
  }
}

export async function deleteAccount(): Promise<DeleteAccountResponse> {
  const res = await fetch(`${API_BASE}/auth/account`, {
    method: 'DELETE',
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('deleteAccountFailed'))
  }
  return res.json() as Promise<DeleteAccountResponse>
}

/**
 * Start an email change: re-verifies the password and emails a confirmation
 * link to the NEW address. Nothing changes until that link is opened, so a
 * typo cannot lock the user out.
 */
export async function changeEmail(
  currentPassword: string,
  newEmail: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/change-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...baseHeaders() },
    credentials: 'include',
    body: JSON.stringify({
      current_password: currentPassword,
      new_email: newEmail,
    }),
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('changeEmailFailed'))
  }
}

/** Complete an email change with the emailed single-use token. */
export async function confirmEmailChange(token: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/confirm-email-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...baseHeaders() },
    credentials: 'include',
    body: JSON.stringify({ token }),
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('confirmEmailChangeFailed'))
  }
}

/**
 * Whether this instance can send email at all (password reset, email change).
 * Instance-level and account-independent, so it is safe to expose — the reset
 * endpoint itself answers 200 uniformly (no user enumeration) and therefore
 * cannot tell the user that no email will arrive.
 */
export async function fetchEmailDeliveryEnabled(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/auth/email-delivery`, {
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) throw await apiError(res, apiFallback('emailDeliveryStatusFailed'))
  const body = (await res.json()) as { enabled: boolean }
  return body.enabled
}

export interface RegisterPayload {
  name: string
  email: string
  password: string
  dob: string
  gender: string
  migrate_data: boolean
}

export interface RegisterResponse {
  id: string
  email: string
  name: string
  dob: string
  gender: string
  external_id: string
}

/**
 * Register a new account. Goes through the shared api layer so the request
 * carries Accept-Language (localized backend errors) and a 422 validation
 * array becomes readable text instead of crashing on `[object Object]`
 * (ISSUES.md #62).
 */
export async function registerUser(payload: RegisterPayload): Promise<RegisterResponse> {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...baseHeaders() },
    credentials: 'include',
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('registerFailed'))
  }
  return res.json() as Promise<RegisterResponse>
}

/**
 * Request a password-reset email. Through the shared api layer so the request
 * carries Accept-Language and a 422 validation array becomes readable text
 * instead of crashing the auth page on an object rendered as a React child.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...baseHeaders() },
    credentials: 'include',
    body: JSON.stringify({ email }),
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('resetRequestFailed'))
  }
}

/** Complete a password reset with the emailed single-use token. */
export async function resetUserPassword(token: string, newPassword: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...baseHeaders() },
    credentials: 'include',
    body: JSON.stringify({ token, new_password: newPassword }),
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('resetPasswordFailed'))
  }
}

function contentDispositionFilename(header: string | null, fallback: string): string {
  if (!header) return fallback
  // RFC 5987: filename*=UTF-8''<percent-encoded> wins when present — it is
  // the only form that survives non-ASCII filenames (ISSUES.md #75).
  const ext = /filename\*=(?:UTF-8|utf-8)''([^;\s]+)/.exec(header)
  if (ext?.[1]) {
    try {
      return decodeURIComponent(ext[1].replace(/^"|"$/g, ''))
    } catch {
      /* malformed encoding — fall through to plain filename */
    }
  }
  const m = /filename="?([^";]+)"?/.exec(header)
  return m?.[1] || fallback
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * Download the caller's full data export (GET /api/export) as a file. Goes
 * through the same authenticated proxy as every other API call (a plain
 * anchor navigation cannot send the Authorization header). The filename is
 * taken from the backend's Content-Disposition when present, else derived
 * from the format + date.
 */
export async function downloadAccountExport(format: 'json' | 'csv'): Promise<void> {
  const res = await fetch(`${API_BASE}/export?format=${format}`, {
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) {
    throw await apiError(res, apiFallback('exportFailed'))
  }
  const blob = await res.blob()
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const fallback = format === 'csv'
    ? `healthpassport-readings-${dateStamp}.csv`
    : `healthpassport-backup-${dateStamp}.json`
  triggerBlobDownload(blob, contentDispositionFilename(res.headers.get('content-disposition'), fallback))
}

/* ----- Usage Limits ----- */
export async function fetchUsageLimits(): Promise<UsageLimits> {
  return apiGet<UsageLimits>('/usage/limits')
}

/**
 * Verify the backend access token by calling /api/auth/me.
 * Returns the user when the token is valid, or null when it is missing/invalid
 * (401). This is the source of truth for "actually logged in" — independent of
 * NextAuth's local session cookie, which can outlive an invalidated backend token.
 */
export async function fetchCurrentUser(token: string | null | undefined): Promise<CurrentUser | null> {
  if (!token) return null
  const res = await fetch(`${API_BASE}/auth/me`, {
    // Accept-Language too (ISSUES.md #66): a 401/403 detail from this call
    // is shown to the user, so it must arrive localized.
    headers: { Authorization: `Bearer ${token}`, 'Accept-Language': getApiLocale() },
    credentials: 'include',
  })
  if (res.status === 401) return null
  if (!res.ok) {
    throw await apiError(res, 'GET /auth/me failed')
  }
  return res.json()
}

/** Fetch the anonymous session id (creates one server-side on first call). */
export async function fetchAnonId(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/anon-id`, {
      credentials: 'include',
      headers: { 'Accept-Language': getApiLocale() },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { anon_id: string }
    return data.anon_id || null
  } catch {
    return null
  }
}

/* ----- Share links (roadmap 1.1) ----- */

/**
 * Create a link to the caller's own record. The raw token comes back exactly
 * once: only its hash is stored, so the sender can never re-display it and
 * "resend the same link" means "create a new one".
 */
export async function createShareLink(): Promise<ShareLinkCreated> {
  const res = await fetch(`${API_BASE}/share/links`, {
    method: 'POST',
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) throw await apiError(res, apiFallback('postShareLinkFailed'))
  return res.json()
}

/** Every link the caller ever created, newest first — expired and revoked rows
 *  included, because the sender's history is the point. */
export async function listShareLinks(): Promise<{ links: ShareLinkSummary[] }> {
  return apiGet<{ links: ShareLinkSummary[] }>('/share/links')
}

/** Close one link. Immediate — the recipient's next load is a dead link. */
export async function revokeShareLink(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/share/links/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) throw await apiError(res, apiFallback('postShareRevokeFailed'))
}

/** The sender's escape hatch when they are not sure what is still out there. */
export async function revokeAllShareLinks(): Promise<{ revoked: number }> {
  const res = await fetch(`${API_BASE}/share/links/revoke-all`, {
    method: 'POST',
    headers: { ...baseHeaders() },
    credentials: 'include',
  })
  if (!res.ok) throw await apiError(res, apiFallback('postShareRevokeFailed'))
  return res.json()
}
