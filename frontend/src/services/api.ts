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
export async function fetchFlowsheetData(): Promise<FlowsheetResponse> {
  const res = await fetch(`${API_BASE}/flowsheet`, {
    cache: 'no-store',
    headers: { ...authHeaders() },
    credentials: 'include',
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
      const detail = await res.json().catch(() => ({ detail: 'Usage limit reached' }))
      throw new UsageLimitError(res.status, detail.detail || 'Usage limit reached')
    }
    const detail = await res.json().catch(() => ({ detail: 'POST /extract failed' }))
    throw new ApiError(res.status, detail.detail || 'POST /extract failed')
  }

  if (!res.body) throw new Error('Response body is missing — cannot read extraction stream')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventType = ''
  let data = ''
  let result: StandardizedMedicalRecord | null = null

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
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Extraction aborted', 'AbortError')
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

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
      const detail = await res.json().catch(() => ({ detail: 'Usage limit reached' }))
      throw new UsageLimitError(res.status, detail.detail || 'Usage limit reached')
    }
    const detail = await res.json().catch(() => ({ detail: 'POST /entry failed' }))
    throw new ApiError(res.status, detail.detail || 'POST /entry failed')
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
      const detail = await res.json().catch(() => ({ detail: 'Usage limit reached' }))
      throw new UsageLimitError(res.status, detail.detail || 'Usage limit reached')
    }
    const detail = await res.json().catch(() => ({ detail: 'POST /entry/merge failed' }))
    throw new ApiError(res.status, detail.detail || 'POST /entry/merge failed')
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
    const detail = await res.json().catch(() => ({ detail: 'Delete failed' }))
    throw new ApiError(res.status, detail.detail || 'DELETE /entry failed')
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
