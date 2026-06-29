import type {
  TimelineResponse,
  FlowsheetResponse,
  BiomarkerResult,
  SaveEntryResponse,
} from '@/lib/types'

const API_BASE = 'http://localhost:8000/api'

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed: ${res.statusText}`)
  return res.json()
}

/* ----- Timeline ----- */
export async function fetchTimelineEvents(): Promise<TimelineResponse> {
  return apiGet<TimelineResponse>('/timeline')
}

/* ----- Flowsheet ----- */
export async function fetchFlowsheetData(): Promise<FlowsheetResponse> {
  return apiGet<FlowsheetResponse>('/flowsheet')
}

/* ----- Biomarker Detail ----- */
export async function fetchBiomarkerDetail(id: string): Promise<BiomarkerResult> {
  return apiGet<BiomarkerResult>(`/biomarker/${id}`)
}

/* ----- Entries by Date ----- */
export async function fetchEntriesByDate(date: string, type?: string): Promise<{ date: string; count: number }> {
  const params = `date=${date}${type ? `&type=${type}` : ''}`
  return apiGet<{ date: string; count: number }>(`/entries/by-date?${params}`)
}

/* ----- Save Entry ----- */
export async function saveMedicalEntry(formData: FormData): Promise<SaveEntryResponse> {
  const res = await fetch(`${API_BASE}/entry`, { method: 'POST', body: formData })
  if (!res.ok) throw new ApiError(res.status, 'POST /entry failed')
  return res.json()
}
