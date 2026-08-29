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
  UsageLimits,
  CurrentUser,
  TranslateLang,
} from '@/lib/types'

// Re-exported for callers that historically imported these from the api module.
export type {
  DeleteEntryResponse,
  UsageLimits,
  CurrentUser,
} from '@/lib/types'
import { getAccessToken } from '@/lib/auth-token'

const API_BASE = process.env.NEXT_PUBLIC_API_URL
  ? `${process.env.NEXT_PUBLIC_API_URL}/api`
  : '/api'

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

function authHeaders(): Record<string, string> {
  const token = getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Extract a human-readable message from an error-response body. FastAPI
 * returns `detail` as a string on HTTPException but as an ARRAY of
 * validation-error objects on 422 — those must become readable text, never
 * "[object Object]".
 */
function extractDetail(body: unknown, fallback: string): string {
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
    headers: { ...authHeaders() },
    credentials: 'include',
  })
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed: ${res.statusText}`)
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
    headers: { ...authHeaders() },
    credentials: 'include',
    signal: opts?.signal,
  })
  if (!res.ok) throw new ApiError(res.status, 'GET /flowsheet failed')
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
): Promise<EntriesByDateResponse> {
  const params = `date=${date}${type ? `&type=${type}` : ''}`
  return apiGet<EntriesByDateResponse>(`/entries/by-date?${params}`)
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
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  opts?.signal?.addEventListener('abort', onExternalAbort)
  try {
    const res = await fetch(`${API_BASE}/translate-biomarkers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
        throw new UsageLimitError(res.status, extractDetail(body, 'Usage limit reached'))
      }
      const body = await res.json().catch(() => null)
      throw new ApiError(
        res.status,
        extractDetail(body, 'POST /translate-biomarkers failed'),
      )
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
      throw new Error(
        'Translation timed out — the AI service did not respond in time. Please try again.',
      )
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
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'include',
    body: JSON.stringify({ lang, items }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, extractDetail(body, 'POST /translate-biomarkers/commit failed'))
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
    headers: { ...authHeaders() },
    credentials: 'include',
    signal,
  })
  if (!res.ok) {
    if (res.status === 429) {
      const body = await res.json().catch(() => null)
      throw new UsageLimitError(res.status, extractDetail(body, 'Usage limit reached'))
    }
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, extractDetail(body, 'POST /extract failed'))
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
  const timeoutError = () =>
    new Error('AI extraction timed out — the connection stalled. Please try again.')

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
        let message = 'Extraction failed'
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

export async function saveMedicalEntry(formData: FormData): Promise<SaveEntryResponse> {
  const res = await fetch(`${API_BASE}/entry`, {
    method: 'POST',
    body: formData,
    headers: { ...authHeaders() },
    credentials: 'include',
  })
  if (!res.ok) {
    if (res.status === 429) {
      const body = await res.json().catch(() => null)
      throw new UsageLimitError(res.status, extractDetail(body, 'Usage limit reached'))
    }
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, extractDetail(body, 'POST /entry failed'))
  }
  return res.json()
}

/* ----- Merge into existing entry ----- */
export async function mergeMedicalEntry(
  entryId: string,
  formData: FormData,
): Promise<SaveEntryResponse> {
  const res = await fetch(`${API_BASE}/entry/${encodeURIComponent(entryId)}/merge`, {
    method: 'POST',
    body: formData,
    headers: { ...authHeaders() },
    credentials: 'include',
  })
  if (!res.ok) {
    if (res.status === 429) {
      const body = await res.json().catch(() => null)
      throw new UsageLimitError(res.status, extractDetail(body, 'Usage limit reached'))
    }
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, extractDetail(body, 'POST /entry/merge failed'))
  }
  return res.json()
}

/* ----- Delete Entry ----- */
export async function deleteEntry(id: string): Promise<DeleteEntryResponse> {
  const res = await fetch(`${API_BASE}/entry/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...authHeaders() },
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new ApiError(res.status, extractDetail(body, 'DELETE /entry failed'))
  }
  return res.json() as Promise<DeleteEntryResponse>
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
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
  })
  if (res.status === 401) return null
  if (!res.ok) throw new ApiError(res.status, 'GET /auth/me failed')
  return res.json()
}

/** Fetch the anonymous session id (creates one server-side on first call). */
export async function fetchAnonId(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/anon-id`, { credentials: 'include' })
    if (!res.ok) return null
    const data = (await res.json()) as { anon_id: string }
    return data.anon_id || null
  } catch {
    return null
  }
}
