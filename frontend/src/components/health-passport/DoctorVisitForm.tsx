'use client'

import { useState, useEffect } from 'react'
import { Plus, X, Pill, CheckCircle, Activity } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/shared/Field'
import type { Prescription, Recommendation, ExtractedVisitData } from '@/lib/types'

export function DoctorVisitForm({
  initialData,
  onDataChange,
}: {
  initialData?: ExtractedVisitData | null
  onDataChange?: (data: any) => void
}) {
  const [diagnosis, setDiagnosis] = useState(initialData?.diagnosis ?? '')
  const [chiefComplaint, setChiefComplaint] = useState(initialData?.chief_complaint ?? '')
  const [objectiveFindings, setObjectiveFindings] = useState(initialData?.objective_findings ?? '')
  const [prescriptions, setPrescriptions] = useState<Prescription[]>(
    initialData?.prescriptions?.map((p, i) => ({
      id: `rx-${Date.now()}-${i}`,
      name: p.name,
      dosage: p.dosage,
      instructions: p.instructions,
    })) ?? [],
  )
  const [recommendations, setRecommendations] = useState<Recommendation[]>(
    initialData?.recommendations?.map((r, i) => ({
      id: `rec-${Date.now()}-${i}`,
      text: r,
    })) ?? [],
  )

  useEffect(() => {
    onDataChange?.({ diagnosis, chief_complaint: chiefComplaint, objective_findings: objectiveFindings, prescriptions, recommendations })
  }, [diagnosis, chiefComplaint, objectiveFindings, prescriptions, recommendations, onDataChange])

  function addPrescription() {
    setPrescriptions((prev) => [
      ...prev,
      {
        id: `rx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: '',
        dosage: '',
        instructions: '',
      },
    ])
  }

  function updatePrescription(id: string, key: keyof Prescription, value: string) {
    setPrescriptions((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [key]: value } : p)),
    )
  }

  function removePrescription(id: string) {
    setPrescriptions((prev) => prev.filter((p) => p.id !== id))
  }

  function addRecommendation() {
    setRecommendations((prev) => [
      ...prev,
      {
        id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: '',
      },
    ])
  }

  function updateRecommendation(id: string, value: string) {
    setRecommendations((prev) =>
      prev.map((r) => (r.id === id ? { ...r, text: value } : r)),
    )
  }

  function removeRecommendation(id: string) {
    setRecommendations((prev) => prev.filter((r) => r.id !== id))
  }

  return (
    <div className="mt-5 flex flex-col gap-6">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Clinical Notes
        </h3>

        <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Activity className="size-4 text-blue-500" />
            <span className="text-xs font-semibold uppercase tracking-wide text-blue-500">
              Primary Diagnosis
            </span>
          </div>
          <textarea
            value={diagnosis}
            onChange={(e) => setDiagnosis(e.target.value)}
            placeholder="e.g., Mild Sinus Tachycardia - Under Control..."
            rows={2}
            className="flex w-full rounded-lg border border-blue-500/20 bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        </div>

        <div className="mt-4 space-y-4">
          <Field label="Chief Complaint &amp; Subjective">
            <textarea
              value={chiefComplaint}
              onChange={(e) => setChiefComplaint(e.target.value)}
              placeholder="Patient reports occasional palpitations during heavy exercise..."
              rows={3}
              className="flex w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
            />
          </Field>

          <Field label="Objective Findings">
            <textarea
              value={objectiveFindings}
              onChange={(e) => setObjectiveFindings(e.target.value)}
              placeholder="Heart rhythm is regular. No murmurs, gallops, or rubs heard..."
              rows={3}
              className="flex w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
            />
          </Field>
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Prescriptions &amp; Medications
        </h3>

        <div className="flex flex-col gap-2">
          {prescriptions.map((p) => (
            <div
              key={p.id}
              className="grid grid-cols-[1fr_0.6fr_1fr_auto] items-center gap-2"
            >
              <Input
                value={p.name}
                onChange={(e) => updatePrescription(p.id, 'name', e.target.value)}
                placeholder="Medication name"
              />
              <Input
                value={p.dosage}
                onChange={(e) => updatePrescription(p.id, 'dosage', e.target.value)}
                placeholder="Dosage"
              />
              <Input
                value={p.instructions}
                onChange={(e) =>
                  updatePrescription(p.id, 'instructions', e.target.value)
                }
                placeholder="Instructions"
              />
              <button
                onClick={() => removePrescription(p.id)}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-status-high-bg hover:text-status-high"
              >
                <X className="size-4" />
              </button>
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
          Add Medication
        </Button>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Recommendations
        </h3>

        <div className="flex flex-col gap-2">
          {recommendations.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <Input
                value={r.text}
                onChange={(e) => updateRecommendation(r.id, e.target.value)}
                placeholder="Task / recommendation"
              />
              <button
                onClick={() => removeRecommendation(r.id)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-status-high-bg hover:text-status-high"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={addRecommendation}
          className="mt-2 gap-1.5 text-primary hover:text-primary"
        >
          <CheckCircle className="size-4" />
          Add Recommendation
        </Button>
      </div>
    </div>
  )
}
