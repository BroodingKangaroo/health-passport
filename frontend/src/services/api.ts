import type {
  TimelineResponse,
  FlowsheetResponse,
  BiomarkerResult,
  BiomarkerDefinition,
  SaveEntryResponse,
  StandardizedMedicalRecord,
  ProgressEventPayload,
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

/* ----- Biomarker Definitions ----- */
export async function fetchBiomarkerDefinitions(): Promise<BiomarkerDefinition[]> {
  return apiGet<BiomarkerDefinition[]>('/biomarkers/definitions')
}

/* ----- AI Extraction (SSE stream) ----- */
export async function extractMedicalData(
  file: File,
  onProgress?: (payload: ProgressEventPayload) => void,
): Promise<StandardizedMedicalRecord> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${API_BASE}/extract`, { method: 'POST', body: fd })
  if (!res.ok) throw new ApiError(res.status, 'POST /extract failed')

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''

    for (const part of parts) {
      if (!part.trim()) continue
      const lines = part.split('\n')
      let eventType = ''
      let data = ''
      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.slice(7)
        if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (eventType === 'progress') {
        const parsed = JSON.parse(data)
        onProgress?.(parsed as ProgressEventPayload)
      } else if (eventType === 'result') {
        return JSON.parse(data) as StandardizedMedicalRecord
      } else if (eventType === 'error') {
        throw new Error(JSON.parse(data).message)
      }
    }
  }

  throw new Error('Stream ended without result event')
}

/* ----- Save Entry ----- */
export async function saveMedicalEntry(formData: FormData): Promise<SaveEntryResponse> {
  const res = await fetch(`${API_BASE}/entry`, { method: 'POST', body: formData })
  if (!res.ok) throw new ApiError(res.status, 'POST /entry failed')
  return res.json()
}
