'use client'

import { useState, useEffect } from 'react'
import { Field } from '@/components/shared/Field'
import type { ExtractedImagingData } from '@/lib/types'

const MODALITIES = ['MRI', 'CT', 'X-Ray', 'Ultrasound', 'Mammography', 'PET Scan', 'Other']

export function ImagingForm({
  initialData,
  onDataChange,
}: {
  initialData?: ExtractedImagingData | null
  onDataChange?: (data: ExtractedImagingData) => void
}) {
  const [modality, setModality] = useState(initialData?.modality ?? '')
  const [findings, setFindings] = useState(initialData?.findings ?? '')
  const [conclusion, setConclusion] = useState(initialData?.conclusion ?? '')

  useEffect(() => {
    onDataChange?.({ modality, findings, conclusion })
  }, [modality, findings, conclusion, onDataChange])

  return (
    <div className="mt-5 flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-foreground">Imaging Report</h3>

      <Field label="Modality">
        <select
          value={modality}
          onChange={(e) => setModality(e.target.value)}
          className="flex h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <option value="">Select modality...</option>
          {MODALITIES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Findings">
        <textarea
          value={findings}
          onChange={(e) => setFindings(e.target.value)}
          rows={4}
          placeholder="Describe the imaging findings..."
          className="flex w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      </Field>

      <Field label="Conclusion / Impression">
        <textarea
          value={conclusion}
          onChange={(e) => setConclusion(e.target.value)}
          rows={3}
          placeholder="Summary and clinical impression..."
          className="flex w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      </Field>
    </div>
  )
}
