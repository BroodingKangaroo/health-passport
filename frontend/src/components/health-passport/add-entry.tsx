'use client'

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import dynamic from 'next/dynamic'
import {
  UploadCloud,
  Loader2,
  Sparkles,
  FileText,
  Pencil,
  ImagePlus,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { useAutoResize } from '@/lib/hooks/useAutoResize'
import { useQueryClient } from '@tanstack/react-query'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/shared/Field'
import { DoctorVisitForm } from './DoctorVisitForm'
import { LabResultForm } from './LabResultForm'
import { ImagingForm } from './ImagingForm'
import { saveMedicalEntry, mergeMedicalEntry, fetchEntriesByDate, extractMedicalData, UsageLimitError, buildSaveEntryFormData } from '@/services/api'
import { toast } from 'sonner'
import type {
  UploadState,
  EntryMode,
  FormCategory,
  FormBiomarkerRow,
  Reference,
  StandardizedBiomarker,
  ProgressStage,
  EntrySummary,
  ExtractedVisitData,
  ExtractedImagingData,
} from '@/lib/types'
import type { UnitConflict } from './unit-conflict-dialog'
import { UnitConflictDialog } from './unit-conflict-dialog'

const DocumentViewer = dynamic(
  () => import('@/components/shared/DocumentViewer').then((m) => m.DocumentViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading document viewer...
      </div>
    ),
  },
)

const docPills = [
  { emoji: '📄', label: 'Lab Results' },
  { emoji: '📝', label: 'Doctor Notes' },
  { emoji: '🩻', label: 'MRI / Scans' },
]

function estimateExtractionTime(chars: number): number {
  return Math.max(5, chars * 0.006)
}

function estimateMatchingTime(biomarkers: number, chars: number): number {
  if (biomarkers > 0) return Math.max(12, biomarkers * 1.2 + 8)
  return Math.max(15, chars * 0.025)
}

function newRow(): FormBiomarkerRow {
  return {
    id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    value: '',
    unit: '',
    reference: null,
  }
}

function manualCategories(): FormCategory[] {
  return [{ id: 'cat-1', name: 'General', rows: [newRow()] }]
}

function biomarkersToCategories(biomarkers: StandardizedBiomarker[]): FormCategory[] {
  const grouped: Record<string, StandardizedBiomarker[]> = {}
  for (const b of biomarkers) {
    const cat = b.category || 'General'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(b)
  }
  return Object.entries(grouped).map(([name, rows]) => ({
    id: `ai-cat-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    rows: rows.map((r) => ({
      id: `ai-bm-${r.standard_name_en.toLowerCase().replace(/\s+/g, '-')}-${Math.random().toString(36).slice(2, 4)}`,
      name: r.standard_name_en,
      value: r.standard_value == null ? '' : String(r.standard_value),
      unit: r.reference?.kind === 'qualitative' ? 'Qualitative' : r.standard_unit,
      reference: r.reference ?? null,
      original_name: r.raw_name,
      original_value: r.raw_value,
      original_unit: r.raw_unit,
      original_range: r.raw_range_string,
      definition_id: r.definition_id,
      scope: r.scope,
      canonical_unit_inferred: r.canonical_unit_inferred,
    })),
  }))
}

export function AddEntry({ onSave }: { onSave: () => Promise<void> | void }) {
  const queryClient = useQueryClient()
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [entryMode, setEntryMode] = useState<EntryMode>('ai')
  const [categories, setCategories] = useState<FormCategory[]>(manualCategories())
  const [documentType, setDocumentType] = useState('blood_test')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [visitFormData, setVisitFormData] = useState<ExtractedVisitData | null>(null)
  const [imagingFormData, setImagingFormData] = useState<ExtractedImagingData | null>(null)
  const [timeValue, setTimeValue] = useState('')
  const [dateValue, setDateValue] = useState('')
  const [duplicateWarning, setDuplicateWarning] = useState(false)
  const [timeRequired, setTimeRequired] = useState(false)
  const [existingBloodTests, setExistingBloodTests] = useState<EntrySummary[]>([])
  const [mergeSelected, setMergeSelected] = useState(false)
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [multiFileNotice, setMultiFileNotice] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [progressStage, setProgressStage] = useState<ProgressStage>('ocr_scanning')
  const [markdownChars, setMarkdownChars] = useState<number | null>(null)
  const [biomarkerCount, setBiomarkerCount] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [prefillClinic, setPrefillClinic] = useState('')
  const [prefillProvider, setPrefillProvider] = useState('')
  const [prefillTitle, setPrefillTitle] = useState('')
  const [prefillNotes, setPrefillNotes] = useState('')
  const [unitConflicts, setUnitConflicts] = useState<UnitConflict[]>([])
  const stageStep: Record<ProgressStage, number> = {
    ocr_scanning: 1,
    extracting: 2,
    matching: 3,
    completed: 4,
  }
  const totalSteps = 3

  const stageInfo: Record<ProgressStage, { label: string; detail: string }> = {
    ocr_scanning: {
      label: 'Scanning document pages...',
      detail: 'Running optical character recognition to extract text from each page of your document.',
    },
    extracting: {
      label: 'Identifying medical data...',
      detail: 'Extracting test names, values, units, reference ranges, and clinical findings from the text.',
    },
    matching: {
      label: 'Standardizing results...',
      detail: 'Matching biomarkers against known definitions, normalizing units, and computing reference statuses.',
    },
    completed: {
      label: 'Done! Reviewing results...',
      detail: 'AI extraction complete. Opening the editor for your review.',
    },
  }

  const dateRef = useRef<HTMLInputElement>(null)
  const timeRef = useRef<HTMLInputElement>(null)
  const clinicRef = useRef<HTMLInputElement>(null)
  const providerRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const resizeNotes = useAutoResize(notesRef)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadFileRef = useRef<HTMLInputElement>(null)
  const elapsedRef = useRef(0)
  const extractionStartRef = useRef(0)
  const stageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasLeftOcrRef = useRef(false)
  const markdownCharsRef = useRef<number | null>(null)
  const extractionAbortRef = useRef<AbortController | null>(null)
  // Stage progress bookkeeping kept as state (not refs) so the render can
  // read it to draw the progress bar — React 19 forbids ref reads during render.
  const [stageStart, setStageStart] = useState(0)
  const [stageEstimate, setStageEstimate] = useState(0)

  const runExtraction = useCallback(async (file: File) => {
    // Cancel any in-flight extraction so its late-arriving result can't
    // overwrite state the user has since edited.
    extractionAbortRef.current?.abort()
    const controller = new AbortController()
    extractionAbortRef.current = controller

    setAiError(null)
    setUploadState('scanning')
    setProgressStage('ocr_scanning')
    setMarkdownChars(null)
    setBiomarkerCount(null)
    setElapsedSeconds(0)
    setStageStart(0)
    setStageEstimate(0)
    elapsedRef.current = 0
    extractionStartRef.current = performance.now()
    if (stageTimeoutRef.current !== null) clearTimeout(stageTimeoutRef.current)
    stageTimeoutRef.current = null
    hasLeftOcrRef.current = false
    markdownCharsRef.current = null
    const setStage = (stage: string) => {
      setProgressStage(stage as ProgressStage)
    }

    try {
      const result = await extractMedicalData(
        file,
        (payload) => {
          const now = elapsedRef.current
          if (payload.markdown_chars != null) {
          markdownCharsRef.current = payload.markdown_chars
          setMarkdownChars(payload.markdown_chars)
          setStageStart(now)
          const estExt = estimateExtractionTime(payload.markdown_chars)
          const estBm = Math.round(payload.markdown_chars * 0.007)
          const estMatch = estimateMatchingTime(estBm, payload.markdown_chars)
          setStageEstimate(Math.round(estExt + estMatch))
        }
        if (payload.biomarker_count != null) {
          setBiomarkerCount(payload.biomarker_count)
          setStageStart(now)
          const chars = markdownCharsRef.current ?? 0
          setStageEstimate(Math.round(estimateMatchingTime(payload.biomarker_count, chars)))
        }
        if (stageTimeoutRef.current !== null) clearTimeout(stageTimeoutRef.current)
        stageTimeoutRef.current = null
        if (!hasLeftOcrRef.current && payload.stage !== 'ocr_scanning') {
          hasLeftOcrRef.current = true
          const took = performance.now() - extractionStartRef.current
          if (took < 1200) {
            stageTimeoutRef.current = setTimeout(() => setStage(payload.stage), 1200 - took)
            return
          }
        }
        setStage(payload.stage)
        },
        controller.signal,
      )
      setEntryMode('ai')
      setDocumentType(result.entry_type)

      if (result.date) {
        setDateValue(result.date)
      }
      if (result.time) {
        setTimeValue(result.time)
      }
      if (result.clinic) setPrefillClinic(result.clinic)
      if (result.provider) setPrefillProvider(result.provider)
      if (result.title) setPrefillTitle(result.title)
      if (result.notes) setPrefillNotes(result.notes)

      if (result.entry_type === 'blood_test' && result.biomarkers && result.biomarkers.length > 0) {
        const cats = biomarkersToCategories(result.biomarkers)
        setCategories(cats)
        // Detect unit conflicts (biomarkers where cross-scale conversion was applied)
        const conflicts: UnitConflict[] = []
        for (const bm of result.biomarkers) {
          if (bm.scale_function) {
            for (const cat of cats) {
              for (const row of cat.rows) {
                if (row.original_name === bm.raw_name && row.original_unit === bm.raw_unit) {
                  conflicts.push({
                    catId: cat.id,
                    rowId: row.id,
                    name: bm.standard_name_en,
                    rawUnit: bm.raw_unit,
                    standardUnit: bm.standard_unit,
                    scaleFunction: bm.scale_function,
                    keepConverted: true,
                    originalValue: row.original_value ?? '',
                    originalUnit: row.original_unit ?? '',
                  })
                }
              }
            }
          }
        }
        setUnitConflicts(conflicts)
        setVisitFormData(null)
        setImagingFormData(null)
      } else if (result.entry_type === 'doctor_visit' && result.visit_data) {
        setVisitFormData(result.visit_data)
        setCategories(manualCategories())
        setImagingFormData(null)
      } else if (result.entry_type === 'imaging') {
        setImagingFormData(result.imaging_data ?? null)
        setCategories(manualCategories())
        setVisitFormData(null)
      } else {
        setCategories(manualCategories())
        setVisitFormData(null)
        setImagingFormData(null)
      }

      setStage('completed')
      await new Promise((r) => setTimeout(r, 1500))
      setUploadState('editor')
    } catch (err: unknown) {
      // Ignore aborts from a superseding extraction — the new run is in charge.
      if (err instanceof Error && err.name === 'AbortError') return
      if (err instanceof UsageLimitError) {
        toast.error('AI Extraction Limit Reached', {
          description: err.message,
        })
      }
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'AI extraction failed'
      setAiError(msg)
      setEntryMode('manual')
      setCategories(manualCategories())
      setUploadState('editor')
    }
  }, [])

  // Reset duplicate-detection/merge state when the date or document type
  // changes. Adjusted during render (React 19's "storing info from previous
  // renders" pattern) because it's derived state — no setState-in-effect here.
  const [prevFilter, setPrevFilter] = useState({ type: documentType, date: dateValue })
  if (prevFilter.type !== documentType || prevFilter.date !== dateValue) {
    setPrevFilter({ type: documentType, date: dateValue })
    setDuplicateWarning(false)
    setTimeRequired(false)
    setExistingBloodTests([])
    setMergeSelected(false)
    setMergeTargetId(null)
  }

  useEffect(() => {
    if (!dateValue || documentType !== 'blood_test') return
    const controller = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await fetchEntriesByDate(dateValue, 'blood_test')
        // Ignore stale responses
        if (controller.signal.aborted) return
        setExistingBloodTests(res.entries ?? [])
        const hasDuplicate = (res.entries?.length ?? 0) > 0
        setDuplicateWarning(hasDuplicate)
        setTimeRequired(hasDuplicate)
        // A changed date invalidates any merge selection; default to the first
        // candidate when a single blood test exists on the date.
        setMergeSelected(false)
        setMergeTargetId((prev) => (prev && res.entries?.some((e) => e.id === prev) ? prev : res.entries?.[0]?.id ?? null))
      } catch {
        // ignore fetch errors
      }
    }, 300)
    return () => {
      clearTimeout(t)
      controller.abort()
    }
  }, [dateValue, documentType])

  // Merge target + conflict detection against the biomarkers already present
  // in the existing entry the user picked. A conflict (same biomarker in both
  // tests) disables merging — a merged entry can't hold two readings of one
  // analyte. Rows the backend would skip (empty name/value) are ignored.
  const selectedMergeTarget = useMemo(() => {
    if (mergeTargetId) return existingBloodTests.find((e) => e.id === mergeTargetId) ?? null
    return existingBloodTests[0] ?? null
  }, [existingBloodTests, mergeTargetId])
  const mergeConflicts = useMemo(() => {
    if (!selectedMergeTarget) return []
    const keys = new Set<string>()
    const names = new Set<string>()
    const synonyms: string[] = []
    for (const b of selectedMergeTarget.biomarkers) {
      keys.add(b.definition_id)
      if (b.loinc_code) keys.add(b.loinc_code)
      for (const n of Object.values(b.names ?? {})) names.add(n.toLowerCase())
      for (const s of b.synonyms ?? []) synonyms.push(s.toLowerCase())
    }
    const conflicts: string[] = []
    for (const cat of categories) {
      for (const row of cat.rows) {
        if (!row.name.trim() || !row.value.trim()) continue
        const nameLower = row.name.trim().toLowerCase()
        // Rows carrying a definition_id conflict when that id (or its LOINC
        // code) is already in the target. Manually-typed rows without one are
        // resolved by name on the server — match those client-side too, so the
        // checkbox isn't left enabled for a merge that will 409. The server
        // resolves names exactly (ILIKE without wildcards) but synonyms with
        // substring containment (ILIKE '%name%'), so a typed name that is a
        // substring of an existing synonym also conflicts.
        const conflictsById = !!row.definition_id && keys.has(row.definition_id)
        const conflictsByName =
          !row.definition_id &&
          (names.has(nameLower) || synonyms.some((s) => s.includes(nameLower)))
        if (conflictsById || conflictsByName) {
          conflicts.push(row.name)
        }
      }
    }
    return conflicts
  }, [selectedMergeTarget, categories])
  const mergeBlocked = mergeConflicts.length > 0
  const merging = mergeSelected && !mergeBlocked && !!selectedMergeTarget

  // If the box is ticked and a conflict shows up afterwards (e.g. the AI
  // extraction lands a biomarker that's already in the target, or the user
  // edits a row into conflict), reset the selection: a checked-but-blocked
  // box is a lie, and saving would silently create a duplicate entry — the
  // exact thing merging exists to prevent. Adjusted during render (React 19's
  // "adjusting state when props change" pattern) instead of in an effect.
  if (mergeSelected && mergeBlocked) {
    setMergeSelected(false)
  }

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [objectUrl])

  useEffect(() => {
    if (uploadState !== 'scanning') return
    const interval = setInterval(() => {
      setElapsedSeconds((s) => {
        const n = s + 1
        elapsedRef.current = n
        return n
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [uploadState])

  useEffect(() => { resizeNotes() }, [resizeNotes, prefillNotes])

  function handleFiles(files: FileList | null) {
    const list = files ? Array.from(files) : []
    if (list.length === 0) return
    // The extraction and save pipeline is single-document; when several files
    // are dropped, deterministically process the first and say so.
    const file = list[0]
    setMultiFileNotice(
      list.length > 1 ? 'Only the first document is processed — upload files one at a time.' : null,
    )
    setSelectedFile(file)
    setObjectUrl(URL.createObjectURL(file))
    if (fileRef.current) {
      const dt = new DataTransfer()
      dt.items.add(file)
      fileRef.current.files = dt.files
    }
    runExtraction(file)
  }

  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    handleFiles(e.target.files)
    e.target.value = ''
  }

  function handleDragOver(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function handleDragEnter(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    if (uploadState === 'idle') setDragActive(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setDragActive(false)
  }

  function handleDrop(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setDragActive(false)
    if (uploadState !== 'idle') return
    handleFiles(e.dataTransfer.files)
  }

  function startManual() {
    setEntryMode('manual')
    setCategories(manualCategories())
    setUploadState('editor')
    setSelectedFile(null)
    setObjectUrl(null)
    setAiError(null)
    setMultiFileNotice(null)
    setDragActive(false)
  }

  function handleFileRefChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      setSelectedFile(file)
      setObjectUrl(URL.createObjectURL(file))
    }
  }

  function updateRow(
    catId: string,
    rowId: string,
    key: keyof FormBiomarkerRow,
    val: string | Reference | null,
  ) {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId
          ? { ...c, rows: c.rows.map((r) => (r.id === rowId ? { ...r, [key]: val } : r)) }
          : c,
      ),
    )
  }

  function removeRow(catId: string, rowId: string) {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId ? { ...c, rows: c.rows.filter((r) => r.id !== rowId) } : c,
      ),
    )
  }

  function addRow(catId: string) {
    setCategories((prev) =>
      prev.map((c) => (c.id === catId ? { ...c, rows: [...c.rows, newRow()] } : c)),
    )
  }

  function addCategory() {
    setCategories((prev) => [
      ...prev,
      { id: `cat-${Date.now()}`, name: 'New Group', rows: [newRow()] },
    ])
  }

  function updateCategoryName(catId: string, name: string) {
    setCategories((prev) => prev.map((c) => (c.id === catId ? { ...c, name } : c)))
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const autoTitle = documentType === 'blood_test' ? 'Blood Test Panel' : documentType === 'doctor_visit' ? 'Doctor Visit' : documentType === 'imaging' ? 'Imaging Report' : 'Medical Record'
      // When merging, send the title as typed (may be empty) so the merge
      // endpoint can fall back to the document filename for the merged section
      // header — the generic auto-title would be useless there. The entry's
      // own title stays untouched on merge anyway.
      const fd = buildSaveEntryFormData({
        type: documentType,
        date: dateRef.current?.value ?? '',
        time: timeValue,
        clinic: clinicRef.current?.value ?? '',
        provider: providerRef.current?.value ?? '',
        title: merging ? (titleRef.current?.value ?? '') : (titleRef.current?.value || autoTitle),
        notes: notesRef.current?.value ?? '',
        biomarkers: categories,
        visit_data: documentType === 'doctor_visit' && visitFormData ? visitFormData : null,
        file: selectedFile ?? fileRef.current?.files?.[0] ?? null,
      })
      const resp = merging && selectedMergeTarget
        ? await mergeMedicalEntry(selectedMergeTarget.id, fd)
        : await saveMedicalEntry(fd)
      if (!resp.success) {
        setSaveError(resp.message || 'Failed to save entry')
        return
      }
      // Invalidate cached server state so the new entry appears immediately.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timeline'] }),
        queryClient.invalidateQueries({ queryKey: ['flowsheet'] }),
        queryClient.invalidateQueries({ queryKey: ['biomarker-definitions'] }),
      ])
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        setObjectUrl(null)
      }
      await onSave()
    } catch (err) {
      if (err instanceof UsageLimitError) {
        toast.error('Storage Limit Reached', {
          description: err.message,
        })
      }
      const msg = err instanceof Error ? err.message : 'Failed to save entry'
      setSaveError(msg)
    } finally {
      setSaving(false)
    }
  }

  if (uploadState === 'idle' || uploadState === 'scanning') {
    let progressWidth: number
    let remainingSeconds: number | null = null

    if (progressStage === 'completed') {
      progressWidth = 100
      remainingSeconds = 0
    } else if (progressStage === 'ocr_scanning') {
      progressWidth = 2
    } else if (progressStage === 'extracting' && markdownChars !== null) {
      remainingSeconds = Math.max(0, stageEstimate - (elapsedSeconds - stageStart))
      progressWidth = Math.min(90, (elapsedSeconds / (elapsedSeconds + remainingSeconds)) * 100)
    } else if (progressStage === 'matching' && biomarkerCount !== null) {
      remainingSeconds = Math.max(0, stageEstimate - (elapsedSeconds - stageStart))
      progressWidth = Math.min(95, (elapsedSeconds / (elapsedSeconds + remainingSeconds)) * 100)
    } else {
      progressWidth = ((stageStep[progressStage] - 1) / totalSteps) * 100
    }

    return (
      <div className="mx-auto max-w-3xl py-4">
        <div className="mb-6 text-center">
          <h1 className="text-balance text-2xl font-bold text-foreground">
            Add New Medical Record
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-pretty text-sm text-muted-foreground">
            Upload lab results, doctor notes, or imaging reports. Our AI will
            automatically extract and categorize the data.
          </p>
        </div>

        <input
          ref={uploadFileRef}
          type="file"
          className="hidden"
          accept=".pdf,.jpg,.jpeg,.png,.tiff,.tif,.bmp"
          onChange={handleFilePicked}
        />

        <button
          type="button"
          onClick={() => uploadState === 'idle' && uploadFileRef.current?.click()}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          disabled={uploadState === 'scanning'}
          className={cn(
            'w-full rounded-xl border-2 border-dashed border-primary/30 bg-accent/40 p-12 text-center transition',
            dragActive && 'border-primary bg-accent/80 ring-2 ring-primary/40',
            uploadState === 'idle' && 'cursor-pointer hover:bg-accent/70',
          )}
        >
          {uploadState === 'idle' ? (
            <div className="flex flex-col items-center gap-4">
              <div className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
                <UploadCloud className="size-8" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Drag &amp; drop a document here, or click to browse.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Supports PDF, JPG, PNG
                </p>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                {docPills.map((p) => (
                  <span
                    key={p.label}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground"
                  >
                    <span aria-hidden>{p.emoji}</span>
                    {p.label}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="relative size-10">
                <div className={`absolute inset-0 transition-all duration-400 ease-out ${
                  progressStage === 'completed' ? 'scale-50 opacity-0' : 'scale-100 opacity-100'
                }`}>
                  <Loader2 className="size-10 animate-spin text-primary" />
                </div>
                <div
                  className={`absolute inset-0 flex items-center justify-center ${
                    progressStage === 'completed'
                      ? 'animate-[scale-in_0.5s_cubic-bezier(0.34,1.56,0.64,1)_forwards]'
                      : 'scale-0 opacity-0'
                  }`}
                >
                  <CheckCircle2 className="size-10 text-primary" />
                </div>
              </div>
              <p className="text-sm font-semibold text-foreground">
                {stageInfo[progressStage].label}
              </p>
              <p className="max-w-sm text-pretty text-xs text-muted-foreground">
                {stageInfo[progressStage].detail}
              </p>
              <div className="mt-1 w-full max-w-xs space-y-1.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
                    style={{ width: `${progressWidth}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {progressStage === 'completed'
                    ? 'Complete!'
                    : <>Step {stageStep[progressStage]} of {totalSteps}
                      {remainingSeconds !== null ? <> · ~{remainingSeconds}s remaining</> : <> · estimating...</>}</>
                  }
                </p>
              </div>
            </div>
          )}
        </button>

        {multiFileNotice && (
          <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            {multiFileNotice}
          </p>
        )}

        {uploadState === 'idle' && (
          <>
            <div className="relative my-6">
              <div className="border-t border-border" />
              <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 bg-background px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                OR
              </span>
            </div>

            <Button
              variant="outline"
              size="lg"
              onClick={startManual}
              className="w-full gap-2"
            >
              <Pencil className="size-4" />
              Skip Upload &amp; Enter Manually
            </Button>
          </>
        )}
      </div>
    )
  }

  const isManual = entryMode === 'manual'

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 py-4">
      <div className="flex items-start gap-5">
        {/* LEFT COLUMN — Document Preview */}
        <div className="sticky top-6 w-[45%] overflow-hidden rounded-xl border bg-card">
          {objectUrl ? (
            selectedFile?.type === 'application/pdf' ? (
              <DocumentViewer key={objectUrl} url={objectUrl} />
            ) : selectedFile?.type.startsWith('image/') ? (
              <div className="flex h-full w-full items-center justify-center p-4">
                <div className="relative h-full w-full overflow-hidden rounded-lg">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={objectUrl}
                    alt={selectedFile?.name ?? 'Uploaded image'}
                    className="h-full w-full object-contain"
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center p-4">
                <h2 className="mb-3 text-sm font-semibold text-foreground">
                  Attached Document
                </h2>
                <div className="flex aspect-[3/4] w-full max-w-xs flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted/60 text-center">
                  <FileText className="size-10 text-muted-foreground/60" />
                  <p className="text-xs font-medium text-foreground">
                    {selectedFile?.name ?? 'Document'}
                  </p>
                  {selectedFile && (
                    <p className="text-[11px] text-muted-foreground">
                      {(selectedFile.size / 1024).toFixed(0)} KB
                    </p>
                  )}
                </div>
              </div>
            )
          ) : isManual ? (
            <div className="flex h-full flex-col items-center justify-center p-4">
              <h2 className="mb-3 text-sm font-semibold text-foreground">
                Attachments (Optional)
              </h2>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex aspect-[3/4] w-full max-w-xs flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-background/60 px-4 text-center transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <ImagePlus className="size-6" />
                </div>
                <p className="text-xs font-medium text-foreground">
                  {selectedFile?.name ?? 'Add a photo or scan'}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Click to attach
                </p>
              </button>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-4">
              <h2 className="mb-3 text-sm font-semibold text-foreground">
                Attached Document
              </h2>
              <div className="flex aspect-[3/4] w-full max-w-xs flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted/60 text-center">
                <FileText className="size-10 text-muted-foreground/60" />
                <p className="text-xs font-medium text-foreground">
                  {selectedFile?.name ?? 'Document'}
                </p>
                {selectedFile && (
                  <p className="text-[11px] text-muted-foreground">
                    {(selectedFile.size / 1024).toFixed(0)} KB
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN — Form */}
        <div className="w-[55%] flex flex-col overflow-hidden rounded-xl border bg-card">
          <div className="flex-1 overflow-y-auto p-4">
            {aiError && (
              <div className="mb-4 flex items-start gap-3 rounded-lg border border-status-high/20 bg-status-high/5 p-3">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-status-high" />
                <div className="text-xs text-foreground">
                  <span className="font-semibold">AI extraction failed</span>
                  <p className="mt-1 text-muted-foreground">{aiError}</p>
                  <p className="mt-1">Switched to manual entry. Fill in the details below.</p>
                </div>
              </div>
            )}

            {!isManual && !aiError && (
              <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-xs text-foreground">
                  <span className="font-semibold">AI successfully identified</span>{' '}
                  a{documentType === 'blood_test' ? ' Blood Test Panel' : documentType === 'doctor_visit' ? ' Doctor Visit.' : documentType === 'imaging' ? 'n Imaging Report' : ' medical document'}
                  {documentType === 'blood_test' && categories.length > 0 && (
                    <> and extracted {categories.reduce((s, c) => s + c.rows.length, 0)} biomarkers.</>
                  )}
                  {' '}Please review for accuracy.
                </p>
              </div>
            )}

            <div className={cn('grid gap-3 sm:grid-cols-2', !isManual && !aiError && 'mt-5')}>
              <Field label="Document Type">
                <select
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  className="flex h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <option value="blood_test">Blood Test Panel</option>
                  <option value="doctor_visit">Doctor Visit / Clinical Notes</option>
                  <option value="imaging">MRI / Imaging Scan</option>
                </select>
              </Field>
              <Field label="Date">
                <Input
                  ref={dateRef}
                  type="date"
                  defaultValue={dateValue}
                  onChange={(e) => setDateValue(e.target.value)}
                />
              </Field>
              <Field label={timeRequired && !merging ? 'Time (required)' : 'Time (optional)'}>
                <Input
                  ref={timeRef}
                  type="time"
                  value={timeValue}
                  onChange={(e) => setTimeValue(e.target.value)}
                  className={timeRequired && !merging ? 'border-red-500' : ''}
                />
                {duplicateWarning && !merging && (
                  <p className="mt-1 text-xs text-red-500">
                    There&apos;s already a blood test on this date. Time is required.
                  </p>
                )}
                {duplicateWarning && existingBloodTests.length > 0 && (
                  <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <label className={cn('flex items-start gap-2.5', mergeBlocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
                      <input
                        type="checkbox"
                        checked={mergeSelected}
                        disabled={mergeBlocked}
                        onChange={(e) => setMergeSelected(e.target.checked)}
                        className="mt-0.5 size-4 accent-primary"
                      />
                      <span>
                        <span className="text-sm font-semibold text-foreground">
                          Merge with this date&apos;s existing blood test
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          Add the new biomarkers and attach this document to the existing entry
                          instead of creating a second one.
                        </span>
                      </span>
                    </label>
                    {mergeBlocked && (
                      <p className="mt-2 text-xs text-red-500">
                        Can&apos;t merge — {mergeConflicts.length === 1 ? 'this biomarker is already' : 'these biomarkers are already'} in
                        the existing test: {mergeConflicts.join(', ')}.
                      </p>
                    )}
                    {mergeSelected && !mergeBlocked && existingBloodTests.length > 1 && (
                      <div className="mt-3 flex items-center gap-2">
                        <label htmlFor="merge-target" className="shrink-0 text-xs font-medium text-muted-foreground">
                          Merge into:
                        </label>
                        <select
                          id="merge-target"
                          value={selectedMergeTarget?.id ?? ''}
                          onChange={(e) => setMergeTargetId(e.target.value)}
                          className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                        >
                          {existingBloodTests.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.title}{c.time ? ` — ${c.time}` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </Field>
              <Field label="Clinic / Source">
                <Input ref={clinicRef} defaultValue={prefillClinic} placeholder="e.g. Invitro Lab" />
              </Field>
              <Field label="Provider / Doctor">
                <Input ref={providerRef} defaultValue={prefillProvider} placeholder="e.g. Dr. Ivanova" />
              </Field>
              <Field label="Title (optional)">
                <Input ref={titleRef} defaultValue={prefillTitle} placeholder="e.g. Pre-Operative Baseline" />
              </Field>
            </div>

            <div className="mt-3">
              <Field label="Patient Notes &amp; Context">
                <textarea
                  ref={notesRef}
                  defaultValue={prefillNotes}
                  onInput={resizeNotes}
                  rows={2}
                  placeholder="e.g. Fasted for 12 hours, felt slight fatigue..."
                  className="flex w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                />
              </Field>
            </div>

            {documentType === 'doctor_visit' ? (
              <DoctorVisitForm
                initialData={visitFormData}
                onDataChange={setVisitFormData}
              />
            ) : documentType === 'imaging' ? (
              <ImagingForm
                initialData={imagingFormData}
                onDataChange={setImagingFormData}
              />
            ) : (
              <LabResultForm
                categories={categories}
                addCategory={addCategory}
                updateCategoryName={updateCategoryName}
                updateRow={updateRow}
                removeRow={removeRow}
                addRow={addRow}
              />
            )}
          </div>

          {saveError && (
            <div className="flex items-start gap-3 border-t border-border p-4 text-xs text-status-high">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border bg-card p-4">
            <input ref={fileRef} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png" onChange={handleFileRefChange} />
            <Button variant="ghost" onClick={onSave} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || ((timeRequired && !timeValue) && !merging)}>
              {saving ? 'Saving...' : merging ? 'Merge & Save' : 'Save to HealthPassport'}
            </Button>
          </div>
        </div>
      </div>

      <UnitConflictDialog
        conflicts={unitConflicts}
        onResolve={(resolved) => {
          for (const c of resolved) {
            if (!c.keepConverted) {
              updateRow(c.catId, c.rowId, 'value', c.originalValue)
              updateRow(c.catId, c.rowId, 'unit', c.originalUnit)
            }
          }
          setUnitConflicts([])
        }}
      />
    </div>
  )
}
