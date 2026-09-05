/**
 * Import-jobs API client (batch import / background extraction).
 *
 * Every call goes through the same Next.js rewrite proxy as services/api.ts
 * (no client-side API base URLs) and carries Accept-Language so the backend
 * localizes its `detail` / error strings.
 */
import type { StandardizedMedicalRecord, ProgressEventPayload } from '@/lib/types'
import { getAccessToken } from '@/lib/auth-token'
import { getApiLocale } from '@/i18n/api-locale'
import { ApiError, extractDetail } from '@/services/api'

const API_BASE = process.env.NEXT_PUBLIC_API_URL
  ? `${process.env.NEXT_PUBLIC_API_URL}/api`
  : '/api'

export type ImportJobStatus = 'queued' | 'processing' | 'done' | 'failed' | 'cancelled' | 'saving'

/** Compact shape returned by the jobs list (tracker/batch polling). */
export interface ImportJobSummary {
  id: string
  status: ImportJobStatus
  stage: string
  progress: ProgressEventPayload | null
  original_filename: string
  file_size: number
  created_at: string | null
  /** Backend-localized failure message (failed jobs only). */
  error: string | null
}

/** Full record (review editor fetch): result has the SSE result-event shape. */
export interface ImportJobDetail extends ImportJobSummary {
  result: StandardizedMedicalRecord | null
  error_key: string | null
  error_params: Record<string, string> | null
  updated_at: string | null
}

function baseHeaders(): Record<string, string> {
  const token = getAccessToken()
  return {
    'Accept-Language': getApiLocale(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function parseError(res: Response, fallback: string): Promise<ApiError> {
  const body = await res.json().catch(() => null)
  return new ApiError(res.status, extractDetail(body, fallback))
}

/** Submit one document for background extraction. Returns the job id. */
export async function createImportJob(file: File): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${API_BASE}/import/jobs`, {
    method: 'POST',
    body: fd,
    headers: baseHeaders(),
    credentials: 'include',
  })
  if (!res.ok) {
    throw await parseError(res, `POST /import/jobs failed: ${res.statusText}`)
  }
  const data = (await res.json()) as { job_id: string }
  return data.job_id
}

/** All of the caller's non-expired jobs (newest first). */
export async function fetchImportJobs(): Promise<{ items: ImportJobSummary[] }> {
  const res = await fetch(`${API_BASE}/import/jobs`, {
    headers: baseHeaders(),
    credentials: 'include',
  })
  if (!res.ok) {
    throw await parseError(res, `GET /import/jobs failed: ${res.statusText}`)
  }
  return res.json()
}

/** Full record for one job — `result` matches the SSE result event shape. */
export async function fetchImportJob(id: string): Promise<ImportJobDetail> {
  const res = await fetch(`${API_BASE}/import/jobs/${encodeURIComponent(id)}`, {
    headers: baseHeaders(),
    credentials: 'include',
  })
  if (!res.ok) {
    throw await parseError(res, `GET /import/jobs/${id} failed: ${res.statusText}`)
  }
  return res.json()
}

export async function cancelImportJob(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/import/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: baseHeaders(),
    credentials: 'include',
  })
  if (!res.ok) {
    throw await parseError(res, `POST /import/jobs/${id}/cancel failed: ${res.statusText}`)
  }
}

export async function retryImportJob(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/import/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    headers: baseHeaders(),
    credentials: 'include',
  })
  if (!res.ok) {
    throw await parseError(res, `POST /import/jobs/${id}/retry failed: ${res.statusText}`)
  }
}

export async function dismissImportJob(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/import/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: baseHeaders(),
    credentials: 'include',
  })
  if (!res.ok) {
    throw await parseError(res, `DELETE /import/jobs/${id} failed: ${res.statusText}`)
  }
}
