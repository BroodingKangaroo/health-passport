'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import { Sparkles, AlertCircle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'

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
  const t = useTranslations('editor')
  const tUpload = useTranslations('upload')
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
      list.length > 1 ? tUpload('multiFileNotice') : null,
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
      // 'New Group' stays English on purpose: it is a DEFAULT CATEGORY NAME
      // seeded into the editable input and persisted to the DB, not a UI label.
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
        setDateError(t('dateRequired'))
        return
      }
      if (dateStr > todayLocal) {
        setDateError(t('dateFuture'))
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
        setSaveError(t('noBiomarkers'))
        return
      }
      // Auto-titles stay English on purpose: they are DEFAULT TITLES written
      // to the DB as the entry title, not UI labels — translating them would
      // change persisted data.
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
        setSaveError(resp.message || t('saveFailed'))
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
        toast.error(t('storageLimitTitle'), {
          description: err.message,
        })
      }
      const msg = err instanceof Error ? err.message : t('saveFailed')
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
                  <span className="font-semibold">{t('aiErrorTitle')}</span>
                  <p className="mt-1 text-muted-foreground">{aiError}</p>
                  <p className="mt-1">{t('aiErrorFallback')}</p>
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
                    {t('tryAgain')}
                  </Button>
                )}
              </div>
            )}

            {!isManual && !aiError && (
              <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-xs text-foreground">
                  <span className="font-semibold">{t('identified')}</span>{' '}
                  {t('identifiedType', { type: documentType })}
                  {documentType === 'blood_test' && categories.length > 0 && (
                    <> {t('extractedBiomarkers', { count: categories.reduce((s, c) => s + c.rows.length, 0) })}</>
                  )}{' '}
                  {t('reviewNote')}
                </p>
              </div>
            )}

            <div className={cn('grid gap-3 sm:grid-cols-2', !isManual && !aiError && 'mt-5')}>
              <Field label={t('documentType')}>
                <select
                  value={documentType}
                  onChange={(e) => handleDocumentTypeChange(e.target.value)}
                  className="flex h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <option value="blood_test">{t('optionBloodTest')}</option>
                  <option value="doctor_visit">{t('optionDoctorVisit')}</option>
                  <option value="instrumental_test">{t('optionInstrumental')}</option>
                </select>
              </Field>
              <Field label={t('date')}>
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
              <Field label={timeRequired && !merging ? t('timeRequired') : t('timeOptional')}>
                <Input
                  ref={timeRef}
                  type="time"
                  value={timeValue}
                  onChange={(e) => setTimeValue(e.target.value)}
                  className={timeRequired && !merging ? 'border-red-500' : ''}
                />
                {duplicateWarning && !merging && (
                  <p className="mt-1 text-xs text-red-500">
                    {t('duplicateWarning')}
                  </p>
                )}
                {duplicateCheckFailed && (
                  <p className="mt-1 text-xs text-amber-600">
                    {t('duplicateCheckFailed')}
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
                          {t('mergeTitle')}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {t('mergeDescription')}
                        </span>
                      </span>
                    </label>
                    {mergeBlocked && (
                      <p className="mt-2 text-xs text-red-500">
                        {t('mergeBlocked', {
                          count: mergeConflicts.length,
                          names: mergeConflicts.join(', '),
                        })}
                      </p>
                    )}
                    {mergeSelected && !mergeBlocked && existingBloodTests.length > 1 && (
                      <div className="mt-3 flex items-center gap-2">
                        <label
                          htmlFor="merge-target"
                          className="shrink-0 text-xs font-medium text-muted-foreground"
                        >
                          {t('mergeInto')}
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
              <Field label={t('clinic')}>
                <Input ref={clinicRef} defaultValue={prefillClinic} placeholder={t('placeholderClinic')} />
              </Field>
              <Field label={t('provider')}>
                <Input ref={providerRef} defaultValue={prefillProvider} placeholder={t('placeholderProvider')} />
              </Field>
              <Field label={t('title')}>
                <Input ref={titleRef} defaultValue={prefillTitle} placeholder={t('placeholderTitle')} />
              </Field>
            </div>

            <div className="mt-3">
              <Field label={t('notes')}>
                <textarea
                  ref={notesRef}
                  defaultValue={prefillNotes}
                  onInput={resizeNotes}
                  rows={2}
                  placeholder={t('placeholderNotes')}
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
              <span>{t('skippedRows', { count: skippedRowCount })}</span>
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
              {t('cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || (timeRequired && !timeValue && !merging)}
            >
              {saving ? t('saving') : merging ? t('mergeSave') : t('save')}
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
