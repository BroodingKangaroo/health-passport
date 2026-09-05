/**
 * Notifications API client (bell icon backend for batch import).
 *
 * Same proxy + Accept-Language conventions as services/api.ts. Emission is
 * worker-side (backend); this module only reads/marks/dismisses.
 */
import { getAccessToken } from '@/lib/auth-token'
import { getApiLocale } from '@/i18n/api-locale'
import { ApiError, extractDetail } from '@/services/api'

const API_BASE = process.env.NEXT_PUBLIC_API_URL
  ? `${process.env.NEXT_PUBLIC_API_URL}/api`
  : '/api'

export type NotificationType = 'import_job_done' | 'import_job_failed'

export interface NotificationItem {
  id: string
  job_id: string | null
  type: NotificationType
  /** Minimal display payload: {job_id, filename}. */
  payload: { job_id?: string; filename?: string }
  read_at: string | null
  created_at: string | null
}

export interface NotificationsResponse {
  unread_count: number
  items: NotificationItem[]
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

/** {unread_count, items[<=50 newest]} — tenant-scoped (anon included). */
export async function fetchNotifications(): Promise<NotificationsResponse> {
  const res = await fetch(`${API_BASE}/notifications`, {
    headers: baseHeaders(),
    credentials: 'include',
  })
  if (!res.ok) {
    throw await parseError(res, `GET /notifications failed: ${res.statusText}`)
  }
  return res.json()
}

/** Idempotent; foreign id -> 404. */
export async function markNotificationRead(id: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/notifications/${encodeURIComponent(id)}/read`,
    { method: 'POST', headers: baseHeaders(), credentials: 'include' },
  )
  if (!res.ok) {
    throw await parseError(res, `POST /notifications/${id}/read failed: ${res.statusText}`)
  }
}

export async function markAllNotificationsRead(): Promise<void> {
  const res = await fetch(`${API_BASE}/notifications/read-all`, {
    method: 'POST',
    headers: baseHeaders(),
    credentials: 'include',
  })
  if (!res.ok) {
    throw await parseError(res, `POST /notifications/read-all failed: ${res.statusText}`)
  }
}

/** Dismiss deletes only the bell row — the staged job expires via GC. */
export async function dismissNotification(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/notifications/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: baseHeaders(),
    credentials: 'include',
  })
  if (!res.ok) {
    throw await parseError(res, `DELETE /notifications/${id} failed: ${res.statusText}`)
  }
}
