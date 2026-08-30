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
  reference_source: 'global' | 'local' | 'pdf_extracted'
  // Canonical (English) unit + scale kind for cross-document comparison.
  // Set on the first reading that defines the biomarker; subsequent
  // readings with a different unit are converted to land on this.
  canonical_unit?: string | null
  // 'linear' | 'log10' | 'ln' — the scale the canonical_unit lives on.
  // Absent for legacy definitions that were never given a canonical unit.
  canonical_kind?: 'linear' | 'log10' | 'ln' | null
  // True when the canonical unit was LLM-invented (the source PDF had no
  // unit cell) rather than translated from an existing unit. Surfaced in
  // the UI so the user can verify it matches their lab's convention.
  canonical_unit_inferred?: boolean
}

export interface MergedSource {
  // Metadata of the second (merged-in) upload: what the user typed for the
  // test that contributed these readings. Present on merged readings only.
  title?: string | null
  clinic?: string | null
  provider?: string | null
  time?: string | null
}

export interface Reading {
  // The medical entry (blood test) the reading belongs to. Lets the client
  // match readings to events unambiguously when several tests share a date.
  entry_id: string
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
  // True when the reading was merged into an existing entry from a later
  // upload (POST /api/entry/{id}/merge) rather than created with it.
  merged?: boolean
  // Source upload metadata for merged readings (see MergedSource).
  merged_source?: MergedSource | null
}

export interface BiomarkerResult {
  id: string
  // Entry the top-level (latest) reading belongs to; history readings carry
  // their own entry_id.
  entry_id: string
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
  merged?: boolean
  merged_source?: MergedSource | null
}

/* ----- Events ----- */
export type EventType = 'blood_test' | 'doctor_visit' | 'instrumental_test' | 'procedure'

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

export interface InstrumentalData {
  modality: string
  findings: string
  conclusion: string
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
  // True when the reading was merged into an existing entry from a later
  // upload rather than created with it.
  merged?: boolean
}

export interface MatrixRow {
  id: string
  name: string
  original: string
  // Detected source-document language of the entry whose reading supplied
  // `original`; null = unknown. Lets the print editor label the original name.
  original_lang?: string | null
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
export type PrintLang = 'ru' | 'en' | 'de' | 'fr' | 'es' | 'he' | 'pl'

// Languages a document can be translated into for print/export (English ->
// target). `ru` is never a translation target: it is the internal sentinel
// for "original" mode (Keep Original), which renders the source-document
// name directly (row.original), regardless of the document's real language.
export type TranslateLang = 'de' | 'fr' | 'es' | 'he' | 'pl'

/* ----- Form Types ----- */
export type UploadState = 'idle' | 'scanning' | 'editor'
export type ProgressStage = 'ocr_scanning' | 'extracting' | 'matching' | 'completed'
export type ProgressEventPayload = {
  stage: ProgressStage
  markdown_chars?: number
  biomarker_count?: number
  // Backend-measured stage estimate (median of recent runs); absent from
  // older backends — callers fall back to the local heuristics then.
  estimate_s?: number
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
  canonical_unit_inferred?: boolean
}

export interface FormCategory {
  id: string
  name: string
  rows: FormBiomarkerRow[]
}

// A biomarker whose document unit differs from the definition's canonical
// unit (a cross-scale conversion was applied during extraction). Shown in the
// add-entry UnitConflictDialog with per-biomarker converted/original choice.
export interface UnitConflict {
  catId: string
  rowId: string
  name: string
  rawUnit: string
  standardUnit: string
  scaleFunction: string
  keepConverted: boolean
  originalValue: string
  originalUnit: string
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
  // True when the canonical unit was LLM-invented (empty unit cell in source).
  canonical_unit_inferred?: boolean
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

export interface ExtractedInstrumentalData {
  modality: string
  findings: string
  conclusion: string
}

export interface StandardizedMedicalRecord {
  entry_type: 'blood_test' | 'doctor_visit' | 'instrumental_test' | 'unknown'
  date?: string | null
  time?: string | null
  clinic?: string | null
  provider?: string | null
  title?: string | null
  notes?: string | null
  // Detected source-document language (deterministic detection on the OCR
  // text, backend-side); null when too short or ambiguous to decide.
  source_language?: string | null
  biomarkers?: StandardizedBiomarker[] | null
  visit_data?: ExtractedVisitData | null
  instrumental_data?: ExtractedInstrumentalData | null
}

/* ----- Entries by Date (duplicate/merge detection) ----- */
export interface EntryBiomarkerRef {
  // The reading's definition id (may itself be a LOINC code for legacy data).
  definition_id: string
  loinc_code: string | null
  // Definition names + synonyms, so the client can detect conflicts for
  // manually-typed rows that carry no definition_id (the server resolves
  // those by name, so the client must be able to as well).
  names?: Record<string, string>
  synonyms?: string[]
}

export interface EntrySummary {
  id: string
  title: string
  date: string
  // "HH:MM" when the entry has a time, else null.
  time: string | null
  // Definitions the entry's readings reference — used to detect biomarker
  // overlap when deciding whether a new upload can merge into this entry.
  biomarkers: EntryBiomarkerRef[]
}

export interface EntriesByDateResponse {
  date: string
  count: number
  entries: EntrySummary[]
}

/* ----- API Response Types ----- */
export interface TimelineResponse {
  events: MedicalEvent[]
  biomarkers: BiomarkerResult[]
  visits: Record<string, VisitData>
  instrumental: Record<string, InstrumentalData>
}

export interface DateHeader {
  label: string
  sub?: string | null
  // Detected source-document language of the entry behind this column;
  // null = unknown (legacy / manual entries).
  source_language?: string | null
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

export interface DeleteEntryResponse {
  success: boolean
  id: string
  deleted_visit_data: boolean
  freed_bytes: number
}

export interface UsageLimits {
  is_anonymous: boolean
  ai_extraction_count: number
  ai_extraction_limit: number
  total_upload_size_bytes: number
  total_upload_limit_bytes: number
}

export interface CurrentUser {
  id: string
  email: string
  name: string
  dob: string
  gender: string
  external_id: string
}