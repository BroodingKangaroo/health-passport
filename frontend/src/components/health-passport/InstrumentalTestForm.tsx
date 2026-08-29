'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Field } from '@/components/shared/Field'
import type { ExtractedInstrumentalData } from '@/lib/types'

// MODALITY labels/values stay as technical acronyms on purpose: the values are
// constrained by the backend extractor (persisted data), the labels are
// universal abbreviations (MRI, CT, ECG...).
const MODALITIES = [
  'MRI',
  'CT',
  'X-Ray',
  'Ultrasound',
  'Elastography',
  'Mammography',
  'PET Scan',
  'ECG',
  'Endoscopy',
  'Other',
]

export function InstrumentalTestForm({
  initialData,
  onDataChange,
}: {
  initialData?: ExtractedInstrumentalData | null
  onDataChange?: (data: ExtractedInstrumentalData) => void
}) {
  const [modality, setModality] = useState(initialData?.modality ?? '')
  const [findings, setFindings] = useState(initialData?.findings ?? '')
  const [conclusion, setConclusion] = useState(initialData?.conclusion ?? '')
  const t = useTranslations('instrumental')

  useEffect(() => {
    onDataChange?.({ modality, findings, conclusion })
  }, [modality, findings, conclusion, onDataChange])

  return (
    <div className="mt-5 flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>

      <Field label={t('modality')}>
        <select
          value={modality}
          onChange={(e) => setModality(e.target.value)}
          className="flex h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <option value="">{t('selectModality')}</option>
          {MODALITIES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('findings')}>
        <textarea
          value={findings}
          onChange={(e) => setFindings(e.target.value)}
          rows={4}
          placeholder={t('placeholderFindings')}
          className="flex w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      </Field>

      <Field label={t('conclusion')}>
        <textarea
          value={conclusion}
          onChange={(e) => setConclusion(e.target.value)}
          rows={3}
          placeholder={t('placeholderConclusion')}
          className="flex w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      </Field>
    </div>
  )
}
