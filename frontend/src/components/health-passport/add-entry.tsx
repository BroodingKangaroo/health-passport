'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import { Sparkles, AlertCircle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { useAutoResize } from '@/lib/hooks/useAutoResize'
import { useQueryClient } from '@tanstack/react-query'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/shared/Field'
import { DoctorVisitForm } from './DoctorVisitForm'
import { LabResultForm } from './LabResultForm'
import { InstrumentalTestForm } from './InstrumentalTestForm'
import { UploadScreen } from './upload-screen'
import { DocumentPreviewPane } from './document-preview-pane'
import { UnitConflictDialog } from './unit-conflict-dialog'
import { ExtractionConfirmDialog } from './extraction-confirm-dialog'
import {
  saveMedicalEntry,
  mergeMedicalEntry,
  buildSaveEntryFormData,
  UsageLimitError,
} from '@/services/api'
import {
  newRow,
  manualCategories,
  biomarkersToCategories,
  buildUnitConflicts,
  hasFormData,
} from '@/lib/biomarker-form'
import { useExtraction } from '@/lib/hooks/useExtraction'
import { useMergePreflight } from '@/lib/hooks/useMergePreflight'
import { useUnitConflicts } from '@/lib/hooks/useUnitConflicts'
import type {
  EntryMode,
  ExtractedInstrumentalData,
  ExtractedVisitData,
  FormCategory,
  FormBiomarkerRow,
  Reference,
  StandardizedMedicalRecord,
} from '@/lib/types'

export function AddEntry({ onSave }: { onSave: () => Promise<void> | void }) {
  const queryClient = useQueryClient()
  const [entryMode, setEntryMode] = useState<EntryMode>('ai')
  const [categories, setCategories] = useState<FormCategory[]>(manualCategories())
  const [documentType, setDocumentType] = useState('blood_test')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [visitFormData, setVisitFormData] = useState<ExtractedVisitData | null>(null)
  const [instrumentalTestFormData, setInstrumentalTestFormData] =
    useState<ExtractedInstrumentalData | null>(null)
  const [timeValue, setTimeValue] = useState('')
  const [dateValue, setDateValue] = useState('')
  const [dateError, setDateError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [multiFileNotice, setMultiFileNotice] = useState<string | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  // A replacement document waiting for the user to confirm its extraction
  // over the form data already present (null = no confirmation pending).
  const [pendingExtractFile, setPendingExtractFile] = useState<File | null>(null)
  const [prefillClinic, setPrefillClinic] = useState('')
  const [prefillProvider, setPrefillProvider] = useState('')
  const [prefillTitle, setPrefillTitle] = useState('')
  const [prefillNotes, setPrefillNotes] = useState('')
  // Source-document language detected at extraction time, relayed to
  // POST /api/entry on save (null in manual mode / failed extractions).
  const [sourceLanguage, setSourceLanguage] = useState<string | null>(null)

  const dateRef = useRef<HTMLInputElement>(null)
  const timeRef = useRef<HTMLInputElement>(null)
  const clinicRef = useRef<HTMLInputElement>(null)
  const providerRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const resizeNotes = useAutoResize(notesRef)
  const fileRef = useRef<HTMLInputElement>(null)

  // Local-today as YYYY-MM-DD (string comparison is valid for ISO dates).
  // Gates the date picker's max and the save-time future-date check.
  const nowLocal = new Date()
  const todayLocal = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, '0')}-${String(nowLocal.getDate()).padStart(2, '0')}`

  // Fan the standardized record out into the editor's form state. Runs while
  // the scan screen still shows "Done! Reviewing results..." — the editor
  // itself appears when useExtraction flips uploadState afterwards.
  function applyExtractedRecord(result: StandardizedMedicalRecord) {
    setEntryMode('ai')
    setDocumentType(result.entry_type)
    setSourceLanguage(result.source_language ?? null)

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
      detectUnitConflicts(buildUnitConflicts(result.biomarkers, cats))
      setVisitFormData(null)
      setInstrumentalTestFormData(null)
    } else if (result.entry_type === 'doctor_visit' && result.visit_data) {
      setVisitFormData(result.visit_data)
      setCategories(manualCategories())
      setInstrumentalTestFormData(null)
    } else if (result.entry_type === 'instrumental_test') {
      setInstrumentalTestFormData(result.instrumental_data ?? null)
      setCategories(manualCategories())
      setVisitFormData(null)
    } else {
      setCategories(manualCategories())
      setVisitFormData(null)
      setInstrumentalTestFormData(null)
    }
  }

  function handleExtractionFailed() {
    setEntryMode('manual')
    setCategories(manualCategories())
    setSourceLanguage(null)
  }

  const {
    uploadState,
    setUploadState,
    progressStage,
    markdownChars,
    biomarkerCount,
    elapsedSeconds,
    stageStart,
    stageEstimate,
    aiError,
    clearError,
    runExtraction,
  } = useExtraction({
    onSuccess: applyExtractedRecord,
    onFailure: handleExtractionFailed,
  })

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

  const {
    unitConflicts,
    detect: detectUnitConflicts,
    applyResolutions,
  } = useUnitConflicts(updateRow)

  const {
    duplicateWarning,
    duplicateCheckFailed,
    timeRequired,
    existingBloodTests,
    mergeSelected,
    setMergeSelected,
    selectedMergeTarget,
    setMergeTargetId,
    mergeConflicts,
    mergeBlocked,
    merging,
  } = useMergePreflight(documentType, dateValue, categories)

  // Rows the backend would skip on save (empty name or value). Counted live
  // so the form can warn before saving: a partially-empty list still saves
  // (the backend drops those rows), but a save with no valid rows and no
  // document is blocked — including the delete-every-row case where both
  // counts are zero.
  const skippedRowCount = useMemo(() => {
    if (documentType !== 'blood_test') return 0
    return categories.reduce(
      (n, cat) => n + cat.rows.filter((r) => !r.name.trim() || !r.value.trim()).length,
      0,
    )
  }, [categories, documentType])
  const validRowCount = useMemo(() => {
    if (documentType !== 'blood_test') return 0
    return categories.reduce(
      (n, cat) => n + cat.rows.filter((r) => r.name.trim() && r.value.trim()).length,
      0,
    )
  }, [categories, documentType])

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [objectUrl])

  useEffect(() => {
    resizeNotes()
  }, [resizeNotes, prefillNotes])

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
    runExtraction(file)
  }

  function startManual() {
    setEntryMode('manual')
    setCategories(manualCategories())
    setUploadState('editor')
    setSelectedFile(null)
    setObjectUrl(null)
    setSourceLanguage(null)
    clearError()
    setMultiFileNotice(null)
  }

  // Switching the document type must clear the companion form state, the same
  // way a fresh AI extraction does: stale categories (extracted biomarker rows)
  // would otherwise be persisted onto a doctor-visit / instrumental-test entry
  // as invisible blood-test readings, and stale visit/instrumental data would
  // leak into the wrong editor.
  function handleDocumentTypeChange(type: string) {
    setDocumentType(type)
    setCategories(manualCategories())
    setVisitFormData(null)
    setInstrumentalTestFormData(null)
  }

  function handleFileRefChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      setSelectedFile(file)
      setObjectUrl(URL.createObjectURL(file))
      // Replacing the source document in AI mode is a fresh start, exactly
      // like the dropzone: re-run the extraction so the new document's data
      // lands in the form — but confirm first when the form already holds
      // data a fresh extraction would wipe. Manual mode keeps plain
      // attach-only semantics.
      if (entryMode !== 'manual') {
        if (hasFormData(documentType, categories, visitFormData, instrumentalTestFormData)) {
          setPendingExtractFile(file)
        } else {
          runExtraction(file)
        }
      }
    }
  }

  function confirmReplacementExtraction() {
    const file = pendingExtractFile
    setPendingExtractFile(null)
    if (file) runExtraction(file)
  }

  function removeFile() {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    setObjectUrl(null)
    setSelectedFile(null)
    // Clear the hidden input too, or Save would silently re-attach the
    // removed file via the fileRef fallback.
    if (fileRef.current) fileRef.current.value = ''
    clearError()
    setMultiFileNotice(null)
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
      // Date is required and must not be in the future — a blank silently
      // saved as "today" and a future date broke timeline ordering before.
      const dateStr = dateRef.current?.value ?? ''
      if (!dateStr) {
        setDateError('Date is required')
        return
      }
      if (dateStr > todayLocal) {
        setDateError('Date can\u2019t be in the future')
        return
      }
      // Saving with no valid rows and no document would create an empty
      // entry — including when every row was deleted (both counts zero).
      // A file-only save (e.g. an AI-extracted report with no biomarkers)
      // stays allowed.
      if (
        documentType === 'blood_test' &&
        validRowCount === 0 &&
        !selectedFile
      ) {
        setSaveError('Add at least one biomarker with a name and value.')
        return
      }
      const autoTitle =
        documentType === 'blood_test'
          ? 'Blood Test Panel'
          : documentType === 'doctor_visit'
            ? 'Doctor Visit'
            : documentType === 'instrumental_test'
              ? 'Instrumental Test Report'
              : 'Medical Record'
      // When merging, send the title as typed (may be empty) so the merge
      // endpoint can fall back to the document filename for the merged section
      // header — the generic auto-title would be useless there. The entry's
      // own title stays untouched on merge anyway.
      // Biomarker rows only exist for blood tests; doctor-visit and
      // instrumental-test entries must not carry (possibly stale) reading
      // rows, or an entry could silently accumulate invisible biomarkers.
      const biomarkers = documentType === 'blood_test' ? categories : []
      const fd = buildSaveEntryFormData({
        type: documentType,
        date: dateStr,
        time: timeValue,
        clinic: clinicRef.current?.value ?? '',
        provider: providerRef.current?.value ?? '',
        title: merging ? (titleRef.current?.value ?? '') : (titleRef.current?.value || autoTitle),
        notes: notesRef.current?.value ?? '',
        source_language: sourceLanguage ?? '',
        biomarkers,
        visit_data:
          documentType === 'doctor_visit' && visitFormData ? visitFormData : null,
        instrumental_data:
          documentType === 'instrumental_test' && instrumentalTestFormData
            ? instrumentalTestFormData
            : null,
        file: selectedFile ?? fileRef.current?.files?.[0] ?? null,
      })
      const resp =
        merging && selectedMergeTarget
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
    return (
      <UploadScreen
        uploadState={uploadState}
        progressStage={progressStage}
        markdownChars={markdownChars}
        biomarkerCount={biomarkerCount}
        elapsedSeconds={elapsedSeconds}
        stageStart={stageStart}
        stageEstimate={stageEstimate}
        multiFileNotice={multiFileNotice}
        onFiles={handleFiles}
        onStartManual={startManual}
      />
    )
  }

  const isManual = entryMode === 'manual'

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 py-4">
      <div className="flex items-start gap-5">
        {/* LEFT COLUMN — Document Preview */}
        <DocumentPreviewPane
          objectUrl={objectUrl}
          selectedFile={selectedFile}
          onRemove={removeFile}
          onAttachClick={() => fileRef.current?.click()}
        />

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
                {selectedFile && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="ml-auto shrink-0"
                    onClick={() => runExtraction(selectedFile)}
                  >
                    <RefreshCw className="size-3.5" />
                    Try again
                  </Button>
                )}
              </div>
            )}

            {!isManual && !aiError && (
              <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-xs text-foreground">
                  <span className="font-semibold">AI successfully identified</span>{' '}
                  a{documentType === 'blood_test' ? ' Blood Test Panel' : documentType === 'doctor_visit' ? ' Doctor Visit.' : documentType === 'instrumental_test' ? 'n Instrumental Test Report' : ' medical document'}
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
                  onChange={(e) => handleDocumentTypeChange(e.target.value)}
                  className="flex h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <option value="blood_test">Blood Test Panel</option>
                  <option value="doctor_visit">Doctor Visit / Clinical Notes</option>
                  <option value="instrumental_test">Instrumental Test (MRI, Elastography, ECG...)</option>
                </select>
              </Field>
              <Field label="Date *">
                <Input
                  ref={dateRef}
                  type="date"
                  required
                  max={todayLocal}
                  defaultValue={dateValue}
                  onChange={(e) => {
                    setDateValue(e.target.value)
                    setDateError(null)
                  }}
                  className={dateError ? 'border-red-500' : ''}
                  aria-invalid={!!dateError}
                />
                {dateError && <p className="mt-1 text-xs text-red-500">{dateError}</p>}
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
                {duplicateCheckFailed && (
                  <p className="mt-1 text-xs text-amber-600">
                    Couldn&apos;t check for existing tests on this date — saving may create a duplicate entry.
                  </p>
                )}
                {duplicateWarning && existingBloodTests.length > 0 && (
                  <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <label
                      className={cn(
                        'flex items-start gap-2.5',
                        mergeBlocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                      )}
                    >
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
                        Can&apos;t merge —{' '}
                        {mergeConflicts.length === 1
                          ? 'this biomarker is already'
                          : 'these biomarkers are already'}{' '}
                        in the existing test: {mergeConflicts.join(', ')}.
                      </p>
                    )}
                    {mergeSelected && !mergeBlocked && existingBloodTests.length > 1 && (
                      <div className="mt-3 flex items-center gap-2">
                        <label
                          htmlFor="merge-target"
                          className="shrink-0 text-xs font-medium text-muted-foreground"
                        >
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
                              {c.title}
                              {c.time ? ` — ${c.time}` : ''}
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
              <DoctorVisitForm initialData={visitFormData} onDataChange={setVisitFormData} />
            ) : documentType === 'instrumental_test' ? (
              <InstrumentalTestForm
                initialData={instrumentalTestFormData}
                onDataChange={setInstrumentalTestFormData}
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

          {skippedRowCount > 0 && validRowCount > 0 && (
            <div className="flex items-start gap-3 border-t border-border p-4 text-xs text-amber-600">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>
                {skippedRowCount} {skippedRowCount === 1 ? 'row is' : 'rows are'} missing a name or
                value and will be skipped on save.
              </span>
            </div>
          )}

          {saveError && (
            <div className="flex items-start gap-3 border-t border-border p-4 text-xs text-status-high">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border bg-card p-4">
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={handleFileRefChange}
            />
            <Button variant="ghost" onClick={onSave} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || (timeRequired && !timeValue && !merging)}
            >
              {saving ? 'Saving...' : merging ? 'Merge & Save' : 'Save to HealthPassport'}
            </Button>
          </div>
        </div>
      </div>

      <UnitConflictDialog conflicts={unitConflicts} onResolve={applyResolutions} />

      <ExtractionConfirmDialog
        fileName={pendingExtractFile?.name ?? null}
        onConfirm={confirmReplacementExtraction}
        onCancel={() => setPendingExtractFile(null)}
      />
    </div>
  )
}
