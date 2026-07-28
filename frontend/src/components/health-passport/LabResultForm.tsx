'use client'

import { Plus, X, ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { BiomarkerCombobox } from './biomarker-combobox'
import { ReferenceInput } from './reference-input'
import { UnitCombobox } from './unit-combobox'
import { isOutsideReference, QUALITATIVE_VALUES } from '@/lib/reference'
import type { FormCategory, FormBiomarkerRow, Reference } from '@/lib/types'

export function LabResultForm({
  categories,
  addCategory,
  updateCategoryName,
  updateRow,
  removeRow,
  addRow,
}: {
  categories: FormCategory[]
  addCategory: () => void
  updateCategoryName: (catId: string, name: string) => void
  updateRow: (catId: string, rowId: string, key: keyof FormBiomarkerRow, val: string | Reference | null) => void
  removeRow: (catId: string, rowId: string) => void
  addRow: (catId: string) => void
}) {
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Biomarkers
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={addCategory}
          className="gap-1.5 text-primary hover:text-primary"
        >
          <Plus className="size-4" />
          Add Category Group
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        {categories.map((cat) => (
          <div key={cat.id}>
            <input
              value={cat.name}
              onChange={(e) => updateCategoryName(cat.id, e.target.value)}
              aria-label="Category name"
              className="mb-1.5 w-full bg-transparent text-[11px] font-semibold uppercase tracking-wide text-muted-foreground outline-none focus:text-foreground"
            />
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="grid grid-cols-[minmax(220px,3fr)_minmax(150px,1.2fr)_120px_minmax(200px,2fr)_auto] items-center gap-x-2 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Biomarker</span>
                <span>Value</span>
                <span>Unit</span>
                <span>Reference range</span>
                <span aria-hidden />
              </div>

              {cat.rows.map((row) => {
                const qualitative = row.unit === 'Qualitative' || row.reference?.kind === 'qualitative'
                const out = isOutsideReference(row.value, row.reference)
                return (
                  <div
                    key={row.id}
                    className="grid grid-cols-[minmax(220px,3fr)_minmax(150px,1.2fr)_120px_minmax(200px,2fr)_auto] items-start gap-x-2 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <BiomarkerCombobox
                      value={row.name}
                      originalName={row.original_name}
                      definitionId={row.definition_id}
                      scope={row.scope}
                      onNameChange={(name) => updateRow(cat.id, row.id, 'name', name)}
                      onUnitChange={(unit) => updateRow(cat.id, row.id, 'unit', unit)}
                      onReferenceChange={(reference) => updateRow(cat.id, row.id, 'reference', reference)}
                      onDefinitionIdChange={(id) => updateRow(cat.id, row.id, 'definition_id', id)}
                      onScopeChange={(s) => updateRow(cat.id, row.id, 'scope', s)}
                    />
                    <div className="relative min-w-0">
                      {qualitative ? (
                        <>
                          <select
                            value={row.value}
                            onChange={(e) => updateRow(cat.id, row.id, 'value', e.target.value)}
                            title={row.value || ''}
                            className={cn(
                              'h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-background pl-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30',
                              out ? 'pr-10' : 'pr-7',
                            )}
                          >
                            <option value="">—</option>
                            {QUALITATIVE_VALUES.map((v) => (
                              <option key={v} value={v}>{v}</option>
                            ))}
                          </select>
                          {out && (
                            <span
                              aria-label="Outside reference range"
                              title="Outside reference range"
                              className="pointer-events-none absolute right-6 top-1/2 size-2 -translate-y-1/2 rounded-full bg-status-high"
                            />
                          )}
                          <ChevronDown
                            aria-hidden
                            className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                          />
                        </>
                      ) : (
                        <>
                          <Input
                            value={row.value}
                            placeholder="—"
                            className={cn(out && 'pr-7')}
                            onChange={(e) =>
                              updateRow(cat.id, row.id, 'value', e.target.value)
                            }
                          />
                          {out && (
                            <span
                              aria-label="Outside reference range"
                              title="Outside reference range"
                              className="pointer-events-none absolute right-2 top-1/2 size-2 -translate-y-1/2 rounded-full bg-status-high"
                            />
                          )}
                        </>
                      )}
                    </div>
                    <UnitCombobox
                      value={row.unit}
                      placeholder="—"
                      onChange={(unit) => {
                        updateRow(cat.id, row.id, 'unit', unit)
                        if (unit === 'Qualitative') {
                          updateRow(cat.id, row.id, 'reference', { kind: 'qualitative', expected: null })
                          updateRow(cat.id, row.id, 'value', '')
                        } else if (row.reference?.kind === 'qualitative') {
                          updateRow(cat.id, row.id, 'reference', null)
                          updateRow(cat.id, row.id, 'value', '')
                        }
                      }}
                    />
                    {qualitative ? (
                      <select
                        value={(row.reference as { expected?: string | null } | null)?.expected ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          updateRow(cat.id, row.id, 'reference', v ? { kind: 'qualitative', expected: v } : null)
                        }}
                        className="h-8 w-full rounded-lg border border-input bg-background px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                      >
                        <option value="">—</option>
                        {QUALITATIVE_VALUES.map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    ) : (
                      <ReferenceInput
                        value={row.reference}
                        onChange={(ref) => updateRow(cat.id, row.id, 'reference', ref)}
                      />
                    )}
                    <button
                      aria-label={`Remove ${row.name || 'biomarker'}`}
                      onClick={() => removeRow(cat.id, row.id)}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-status-high-bg hover:text-status-high"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                )
              })}
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => addRow(cat.id)}
              className="mt-1.5 gap-1.5 text-primary hover:text-primary"
            >
              <Plus className="size-4" />
              Add biomarker
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
