export type Status = 'normal' | 'low' | 'high'

/* ----- Patient ----- */
export interface Patient {
  id: string
  name: string
  dob: string
  gender: string
  external_id: string
}

/* ----- Biomarker ----- */
export interface BiomarkerDefinition {
  id: string
  name_en: string
  name_ru: string
  unit: string
  range_min: number | null
  range_max: number | null
  category: string
}

export interface Reading {
  date: string
  value: number
  status: Status
  original_name?: string
  original_value?: string
  original_unit?: string
  original_range?: string
}

export interface BiomarkerResult {
  id: string
  definition: BiomarkerDefinition
  value: number
  date: string
  status: Status
  history?: Reading[]
  range?: string
  original_name?: string
  original_value?: string
  original_unit?: string
  original_range?: string
}

/* ----- Events ----- */
export type EventType = 'blood_test' | 'doctor_visit' | 'imaging' | 'procedure'

export interface EventAttachment {
  id: string
  name: string
  type: string
  size: string
  description?: string
  url?: string
}

export interface MedicalEvent {
  id: string
  date: string
  type: EventType
  title: string
  clinic: string
  subtitle?: string
  category?: string
  status?: string
  attachments?: EventAttachment[]
}

/* ----- Visit Data ----- */
export interface VisitNote {
  heading: string | null
  text: string
}

export interface VisitPrescription {
  id: number
  name: string
  dose: string
  instruction: string
}

export interface VisitAttachment {
  id: string
  name: string
  type: string
  size: string
  url?: string
}

export interface VisitData {
  specialty: string
  provider: string
  date: string
  clinic: string
  verdict: string
  notes: VisitNote[]
  prescriptions: VisitPrescription[]
  recommendations: string[]
  attachments: VisitAttachment[]
}

/* ----- Flowsheet Matrix ----- */
export interface MatrixCell {
  value: string
  status: Status
}

export interface MatrixRow {
  id: string
  name: string
  original: string
  range: string
  cells: MatrixCell[]
}

export interface MatrixCategory {
  category: string
  rows: MatrixRow[]
}

/* ----- Print / Export ----- */
export type PrintLang = 'ru' | 'en' | 'de' | 'fr' | 'es' | 'he'

export interface DateCol {
  id: string
  year: string
  short: string
  ru: string
}

export interface Marker {
  id: string
  unit: string
  labels: Record<PrintLang, string>
  values: Record<string, { v: string; abnormal?: boolean }>
}

export interface PrintCategory {
  id: string
  name: string
  markers: string[]
}

/* ----- Form Types ----- */
export type UploadState = 'idle' | 'scanning' | 'editor'
export type EntryMode = 'ai' | 'manual'

export interface FormBiomarkerRow {
  id: string
  name: string
  value: string
  unit: string
  range: string
  original_name?: string
  original_value?: string
  original_unit?: string
  original_range?: string
}

export interface FormCategory {
  id: string
  name: string
  rows: FormBiomarkerRow[]
}

export interface Prescription {
  id: string
  name: string
  dosage: string
  instructions: string
}

export interface Recommendation {
  id: string
  text: string
}

/* ----- AI Extraction Types (two-pass: Standardized output) ----- */
export interface StandardizedBiomarker {
  raw_name: string
  raw_value: string
  raw_unit: string
  raw_range_string: string
  standard_name_en: string
  standard_value: number
  standard_unit: string
  standard_range_min: number | null
  standard_range_max: number | null
  status: string
  category: string
}

export interface ExtractedPrescription {
  name: string
  dosage: string
  instructions: string
}

export interface ExtractedVisitData {
  diagnosis: string
  chief_complaint: string
  objective_findings: string
  prescriptions: ExtractedPrescription[]
  recommendations: string[]
}

export interface ExtractedImagingData {
  modality: string
  findings: string
  conclusion: string
}

export interface StandardizedMedicalRecord {
  entry_type: 'blood_test' | 'doctor_visit' | 'imaging' | 'unknown'
  date?: string | null
  time?: string | null
  clinic?: string | null
  provider?: string | null
  title?: string | null
  notes?: string | null
  biomarkers?: StandardizedBiomarker[] | null
  visit_data?: ExtractedVisitData | null
  imaging_data?: ExtractedImagingData | null
}

/* ----- API Response Types ----- */
export interface TimelineResponse {
  events: MedicalEvent[]
  biomarkers: BiomarkerResult[]
  visits: Record<string, VisitData>
}

export interface DateHeader {
  label: string
  sub?: string | null
}

export interface FlowsheetResponse {
  dates: readonly DateHeader[]
  matrix: MatrixCategory[]
  biomarkers: BiomarkerResult[]
}

export interface SaveEntryResponse {
  success: boolean
  message: string
  id: string
}
