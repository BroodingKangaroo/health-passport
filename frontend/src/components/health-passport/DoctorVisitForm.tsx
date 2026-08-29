'use client'

import { useState, useEffect, useRef } from 'react'
import { X, Pill, CheckCircle, Activity, Languages } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useAutoResize } from '@/lib/hooks/useAutoResize'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/shared/Field'
import type { TranslatedText, ExtractedVisitData } from '@/lib/types'


function TxField({
  label,
  value,
  onChange,
  placeholder,
  rows = 1,
}: {
  label: string
  value: TranslatedText
  onChange: (val: TranslatedText) => void
  placeholder?: string
  rows?: number
}) {
  const t = useTranslations('doctorVisit')
  const [showOriginal, setShowOriginal] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const resize = useAutoResize(textareaRef)

  useEffect(() => { resize() }, [value.translated_en, resize])

  return (
    <Field label={label}>
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value.translated_en}
          onChange={(e) => {
            onChange({ ...value, translated_en: e.target.value })
            resize()
          }}
          placeholder={placeholder}
          rows={rows}
          className="flex w-full resize-none overflow-y-hidden rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
        <span className="absolute right-2 top-2 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
          EN
        </span>
      </div>
      {value.original && value.original !== value.translated_en && (
        <button
          type="button"
          onClick={() => setShowOriginal(!showOriginal)}
          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          <Languages className="size-3" />
          {showOriginal ? t('hideOriginal') : t('showOriginal')}
        </button>
      )}
      {showOriginal && value.original && (
        <div className="mt-1 rounded border border-dashed border-muted-foreground/20 bg-muted/30 p-2 text-xs italic text-muted-foreground/70">
          {value.original}
        </div>
      )}
    </Field>
  )
}


function _tx(text: string | TranslatedText): TranslatedText {
  if (typeof text === 'string') return { original: text, translated_en: text }
  return text
}


interface PrescriptionFormItem {
  id: string
  name_editable: string
  name_original: string
  dosage_editable: string
  dosage_original: string
  instructions_editable: string
  instructions_original: string
}

interface RecommendationFormItem {
  id: string
  editable: string
  original: string
}

function RecommendationRow({
  item,
  onRemove,
  setRecItem,
}: {
  item: RecommendationFormItem
  onRemove: () => void
  setRecItem: (val: RecommendationFormItem) => void
}) {
  const t = useTranslations('doctorVisit')
  const ref = useRef<HTMLTextAreaElement>(null)
  const resize = useAutoResize(ref)

  useEffect(() => { resize() }, [item.editable, resize])

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <div className="relative flex-1">
          <textarea
            ref={ref}
            value={item.editable}
            onChange={(e) => {
              setRecItem({ ...item, editable: e.target.value })
              resize()
            }}
            placeholder={t('placeholderRecommendation')}
            rows={1}
            className="flex w-full resize-none overflow-y-hidden rounded-lg border border-input bg-background px-2.5 py-2 pr-8 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          <span className="absolute right-2 top-2 rounded bg-blue-500/10 px-1 py-0.5 text-[10px] font-medium text-blue-500">EN</span>
        </div>
        <button
          onClick={onRemove}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-status-high-bg hover:text-status-high"
        >
          <X className="size-4" />
        </button>
      </div>
      {item.original && item.original !== item.editable && (
        <div className="ml-2 text-xs italic text-muted-foreground/50">
          {t('originalLine', { text: item.original })}
        </div>
      )}
    </div>
  )
}


export function DoctorVisitForm({
  initialData,
  onDataChange,
}: {
  initialData?: ExtractedVisitData | null
  onDataChange?: (data: ExtractedVisitData) => void
}) {
  const t = useTranslations('doctorVisit')
  const [diagnosis, setDiagnosis] = useState<TranslatedText>(_tx(initialData?.diagnosis ?? ''))
  const [chiefComplaint, setChiefComplaint] = useState<TranslatedText>(_tx(initialData?.chief_complaint ?? ''))
  const [objectiveFindings, setObjectiveFindings] = useState<TranslatedText>(_tx(initialData?.objective_findings ?? ''))

  const diagnosisRef = useRef<HTMLTextAreaElement>(null)
  const resizeDiagnosis = useAutoResize(diagnosisRef)

  const [prescriptions, setPrescriptions] = useState<PrescriptionFormItem[]>(
    initialData?.prescriptions?.map((p, i) => ({
      id: `rx-init-${i}`,
      name_editable: _tx(p.name).translated_en,
      name_original: _tx(p.name).original,
      dosage_editable: _tx(p.dosage).translated_en,
      dosage_original: _tx(p.dosage).original,
      instructions_editable: _tx(p.instructions).translated_en,
      instructions_original: _tx(p.instructions).original,
    })) ?? [],
  )

  const [recommendations, setRecommendations] = useState<RecommendationFormItem[]>(
    initialData?.recommendations?.map((r, i) => ({
      id: `rec-init-${i}`,
      editable: _tx(r).translated_en,
      original: _tx(r).original,
    })) ?? [],
  )

  useEffect(() => {
    onDataChange?.({
      diagnosis,
      chief_complaint: chiefComplaint,
      objective_findings: objectiveFindings,
      prescriptions: prescriptions.map((p) => ({
        name: { original: p.name_original, translated_en: p.name_editable },
        dosage: { original: p.dosage_original, translated_en: p.dosage_editable },
        instructions: { original: p.instructions_original, translated_en: p.instructions_editable },
      })),
      recommendations: recommendations.map((r) => ({
        original: r.original,
        translated_en: r.editable,
      })),
    })
  }, [diagnosis, chiefComplaint, objectiveFindings, prescriptions, recommendations, onDataChange])

  function addPrescription() {
    setPrescriptions((prev) => [
      ...prev,
      {
        id: `rx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name_editable: '',
        name_original: '',
        dosage_editable: '',
        dosage_original: '',
        instructions_editable: '',
        instructions_original: '',
      },
    ])
  }

  function removePrescription(id: string) {
    setPrescriptions((prev) => prev.filter((p) => p.id !== id))
  }

  function addRecommendation() {
    setRecommendations((prev) => [
      ...prev,
      {
        id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        editable: '',
        original: '',
      },
    ])
  }

  function removeRecommendation(id: string) {
    setRecommendations((prev) => prev.filter((r) => r.id !== id))
  }

  return (
    <div className="mt-5 flex flex-col gap-6">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          {t('clinicalNotes')}
        </h3>

        <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Activity className="size-4 text-blue-500" />
            <span className="text-xs font-semibold uppercase tracking-wide text-blue-500">
              {t('primaryDiagnosis')}
            </span>
          </div>
          <textarea
            ref={diagnosisRef}
            value={diagnosis.translated_en}
            onChange={(e) => {
              setDiagnosis({ ...diagnosis, translated_en: e.target.value })
              resizeDiagnosis()
            }}
            placeholder={t('placeholderDiagnosis')}
            rows={2}
            className="flex w-full rounded-lg border border-blue-500/20 bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          {diagnosis.original && diagnosis.original !== diagnosis.translated_en && (
            <button
              type="button"
              onClick={() => {
                const el = document.getElementById('diagnosis-original')
                if (el) el.classList.toggle('hidden')
              }}
              className="mt-1 flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              <Languages className="size-3" />
              {t('showOriginal')}
            </button>
          )}
          {diagnosis.original && (
            <div id="diagnosis-original" className="hidden mt-1 rounded border border-dashed border-muted-foreground/20 bg-muted/30 p-2 text-xs italic text-muted-foreground/70">
              {diagnosis.original}
            </div>
          )}
        </div>

        <div className="mt-4 space-y-4">
          <TxField
            label={t('chiefComplaint')}
            value={chiefComplaint}
            onChange={setChiefComplaint}
            placeholder={t('placeholderChiefComplaint')}
          />

          <TxField
            label={t('objectiveFindings')}
            value={objectiveFindings}
            onChange={setObjectiveFindings}
            placeholder={t('placeholderObjective')}
          />
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          {t('prescriptions')}
        </h3>

        <div className="flex flex-col gap-3">
          {prescriptions.map((p) => (
            <div
              key={p.id}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="grid grid-cols-[1fr_0.6fr_1fr_auto] items-center gap-2">
                <div className="relative">
                  <Input
                    value={p.name_editable}
                    onChange={(e) =>
                      setPrescriptions((prev) =>
                        prev.map((r) => (r.id === p.id ? { ...r, name_editable: e.target.value } : r)),
                      )
                    }
                    placeholder={t('placeholderMedication')}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-blue-500/10 px-1 py-0.5 text-[10px] font-medium text-blue-500">EN</span>
                </div>
                <div className="relative">
                  <Input
                    value={p.dosage_editable}
                    onChange={(e) =>
                      setPrescriptions((prev) =>
                        prev.map((r) => (r.id === p.id ? { ...r, dosage_editable: e.target.value } : r)),
                      )
                    }
                    placeholder={t('placeholderDosage')}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-blue-500/10 px-1 py-0.5 text-[10px] font-medium text-blue-500">EN</span>
                </div>
                <div className="relative">
                  <Input
                    value={p.instructions_editable}
                    onChange={(e) =>
                      setPrescriptions((prev) =>
                        prev.map((r) => (r.id === p.id ? { ...r, instructions_editable: e.target.value } : r)),
                      )
                    }
                    placeholder={t('placeholderInstructions')}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-blue-500/10 px-1 py-0.5 text-[10px] font-medium text-blue-500">EN</span>
                </div>
                <button
                  onClick={() => removePrescription(p.id)}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-status-high-bg hover:text-status-high"
                >
                  <X className="size-4" />
                </button>
              </div>
              {(p.name_original || p.dosage_original || p.instructions_original) && (
                <details className="mt-2 group">
                  <summary className="cursor-pointer text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors">
                    <Languages className="mr-1 inline size-3" />
                    {t('showOriginal')}
                  </summary>
                  <div className="mt-1 space-y-1 rounded border border-dashed border-muted-foreground/20 bg-muted/30 p-2 text-xs italic text-muted-foreground/70">
                    {p.name_original && <div>{t('nameLine', { text: p.name_original })}</div>}
                    {p.dosage_original && <div>{t('dosageLine', { text: p.dosage_original })}</div>}
                    {p.instructions_original && <div>{t('instructionsLine', { text: p.instructions_original })}</div>}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={addPrescription}
          className="mt-2 gap-1.5 text-primary hover:text-primary"
        >
          <Pill className="size-4" />
          {t('addMedication')}
        </Button>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          {t('recommendations')}
        </h3>

        <div className="flex flex-col gap-2">
          {recommendations.map((r) => (
            <RecommendationRow
              key={r.id}
              item={r}
              onRemove={() => removeRecommendation(r.id)}
              setRecItem={(val) =>
                setRecommendations((prev) =>
                  prev.map((rec) => (rec.id === r.id ? val : rec)),
                )
              }
            />
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={addRecommendation}
          className="mt-2 gap-1.5 text-primary hover:text-primary"
        >
          <CheckCircle className="size-4" />
          {t('addRecommendation')}
        </Button>
      </div>
    </div>
  )
}