export interface TranslatedText {
  original: string
  translated_en: string
}

/* ----- Reference ----- */
// A single structured reference. Its `kind` IS the result type — there is no
// separate result_type: an interval reference means a numeric result, a
// qualitative reference means a text result.
export interface ReferenceInterval {
  kind: 'interval'
  low: number | null
  high: number | null
}

export interface ReferenceQualitative {
  kind: 'qualitative'
  expected?: string | null
}

export type Reference = ReferenceInterval | ReferenceQualitative

export type Status = 'normal' | 'low' | 'high' | 'abnormal'

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
  loinc_code?: string | null
  names: Record<string, string>
  synonyms: string[]
  unit: string
  reference: Reference | null
  category: string
  scope: 'global' | 'local'
  user_id?: string | null
  reference_source: 'global' | 'local' | 'pdf_extracted'
  // Canonical (English) unit + scale kind for cross-document comparison.
  // Set on the first reading that defines the biomarker; subsequent
  // readings with a different unit are converted to land on this.
  canonical_unit?: string | null
  canonical_kind?: string | null
  // True when the canonical unit was LLM-invented (the source PDF had no
  // unit cell) rather than translated from an existing unit. Surfaced in
  // the UI so the user can verify it matches their lab's convention.
  canonical_unit_inferred?: boolean
}

export interface Reading {
  date: string
  value: number | string | null
  status: Status
  reference?: Reference | null
  original_name?: string
  original_value?: string
  original_unit?: string
  original_range?: string
  // Scale conversion applied to land `value` in the def's canonical unit.
  // "10^x" / "log10" / "factor:1.5" / null.
  scale_function?: string | null
  // True when the LLM couldn't determine a cross-scale conversion; the
  // reading is kept raw and the UI surfaces a warning.
  needs_review?: boolean
}

export interface BiomarkerResult {
  id: string
  definition: BiomarkerDefinition
  value: number | string | null
  date: string
  status: Status
  history?: Reading[]
  reference?: Reference | null
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
  text_translated: string
  text_original: string
}

export interface VisitPrescription {
  id: number
  name: TranslatedText
  dose: TranslatedText
  instruction: TranslatedText
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
  verdict: TranslatedText
  notes: VisitNote[]
  prescriptions: VisitPrescription[]
  recommendations: TranslatedText[]
  attachments: VisitAttachment[]
}

/* ----- Flowsheet Matrix ----- */
export interface MatrixCell {
  value: string
  status: Status
  // "10^x" / "log10" / "factor:1.5" / null. Surfaced so the UI can show the
  // original in a footnote next to the converted value.
  scale_function?: string | null
  // True when the LLM couldn't determine a cross-scale conversion. The
  // flowsheet cell still renders the raw value; the UI shows a warning.
  needs_review?: boolean
}

export interface MatrixRow {
  id: string
  name: string
  original: string
  unit: string
  reference: Reference | null
  // True when the row's unit was LLM-invented (no source unit on the
  // first reading). Surfaced in the UI so the user can verify it.
  canonical_unit_inferred?: boolean
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
export type ProgressStage = 'ocr_scanning' | 'extracting' | 'matching' | 'completed'
export type ProgressEventPayload = {
  stage: ProgressStage
  markdown_chars?: number
  biomarker_count?: number
}
export type EntryMode = 'ai' | 'manual'

export interface FormBiomarkerRow {
  id: string
  name: string
  value: string
  unit: string
  reference: Reference | null
  original_name?: string
  original_value?: string
  original_unit?: string
  original_range?: string
  definition_id?: string
  scope?: string
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
  standard_value: number | string | null
  standard_unit: string
  reference: Reference | null
  status: string
  category: string
  definition_id: string
  scope: string
  // Scale conversion applied to land `standard_value` in the def's
  // canonical unit. "10^x" / "log10" / "factor:1.5" / null.
  scale_function?: string | null
  // True when the LLM couldn't determine a cross-scale conversion; the
  // reading is kept raw and the UI surfaces a warning.
  needs_review?: boolean
}

export interface ExtractedPrescription {
  name: TranslatedText
  dosage: TranslatedText
  instructions: TranslatedText
}

export interface ExtractedVisitData {
  diagnosis: TranslatedText
  chief_complaint: TranslatedText
  objective_findings: TranslatedText
  prescriptions: ExtractedPrescription[]
  recommendations: TranslatedText[]
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