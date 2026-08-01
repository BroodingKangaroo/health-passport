import type {
  TimelineResponse,
  FlowsheetResponse,
  BiomarkerResult,
  BiomarkerDefinition,
  SaveEntryResponse,
  StandardizedMedicalRecord,
  ProgressEventPayload,
  EntriesByDateResponse,
} from '@/lib/types'
import { getAccessToken } from '@/lib/auth-token'

const API_BASE = process.env.NEXT_PUBLIC_API_URL
  ? `${process.env.NEXT_PUBLIC_API_URL}/api`
  : '/api'

// SSE/streaming endpoints must NOT go through the Next.js rewrite proxy, which
// buffers the whole response body and breaks incremental progress updates.
// Prefer an explicit backend origin; fall back to the backend dev port so the
// stream is consumed directly (CORS on the backend already allows this origin).
function streamApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return `${process.env.NEXT_PUBLIC_API_URL}/api`
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8000/api`
  }
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
    throw new ApiError(res.status, 'POST /extract failed')
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
    throw new ApiError(res.status, 'POST /entry failed')
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
export interface DeleteEntryResponse {
  success: boolean
  id: string
  deleted_visit_data: boolean
  freed_bytes: number
}

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
export interface UsageLimits {
  is_anonymous: boolean
  ai_extraction_count: number
  ai_extraction_limit: number
  total_upload_size_bytes: number
  total_upload_limit_bytes: number
}

export async function fetchUsageLimits(): Promise<UsageLimits> {
  return apiGet<UsageLimits>('/usage/limits')
}

/* ----- Current User (backend-verified auth state) ----- */
export interface CurrentUser {
  id: string
  email: string
  name: string
  dob: string
  gender: string
  external_id: string
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
