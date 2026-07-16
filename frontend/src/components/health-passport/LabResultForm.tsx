'use client'

import { Plus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { BiomarkerCombobox } from './biomarker-combobox'
import { RangeInput } from './range-input'
import { UnitCombobox } from './unit-combobox'
import type { FormCategory, FormBiomarkerRow } from '@/lib/types'

function parseRange(range: string): { lo?: number; hi?: number } {
  const lt = range.match(/<\s*([\d.]+)/)
  if (lt) return { hi: Number.parseFloat(lt[1]) }
  const gt = range.match(/>\s*([\d.]+)/)
  if (gt) return { lo: Number.parseFloat(gt[1]) }
  const m = range.match(/(-?\d+(?:\.\d+)?)\s*[-–]?\s*(-?\d+(?:\.\d+)?)/)
  if (m) return { lo: Number.parseFloat(m[1]), hi: Number.parseFloat(m[2]) }
  return {}
}

function isOutOfRange(value: string, range: string) {
  const v = Number.parseFloat(value)
  if (Number.isNaN(v)) return false
  const { lo, hi } = parseRange(range)
  if (lo !== undefined && v < lo) return true
  if (hi !== undefined && v > hi) return true
  return false
}

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
  updateRow: (catId: string, rowId: string, key: keyof FormBiomarkerRow, val: string) => void
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
              <div className="grid grid-cols-[minmax(220px,3fr)_100px_120px_minmax(200px,2fr)_auto] items-center gap-x-2 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Biomarker</span>
                <span>Value</span>
                <span>Unit</span>
                <span>Range</span>
                <span aria-hidden />
              </div>

              {cat.rows.map((row) => {
                const out = isOutOfRange(row.value, row.range)
                return (
                  <div
                    key={row.id}
                    className="grid grid-cols-[minmax(220px,3fr)_100px_120px_minmax(200px,2fr)_auto] items-start gap-x-2 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <BiomarkerCombobox
                      value={row.name}
                      originalName={row.original_name}
                      definitionId={row.definition_id}
                      scope={row.scope}
                      onNameChange={(name) => updateRow(cat.id, row.id, 'name', name)}
                      onUnitChange={(unit) => updateRow(cat.id, row.id, 'unit', unit)}
                      onRangeChange={(range) => updateRow(cat.id, row.id, 'range', range)}
                      onDefinitionIdChange={(id) => updateRow(cat.id, row.id, 'definition_id', id)}
                      onScopeChange={(s) => updateRow(cat.id, row.id, 'scope', s)}
                    />
                    <div className="relative">
                      <Input
                        value={row.value}
                        placeholder="—"
                        className={cn(out && 'pr-6')}
                        onChange={(e) =>
                          updateRow(cat.id, row.id, 'value', e.target.value)
                        }
                      />
                      {out && (
                        <span
                          aria-label="Out of range"
                          title="Out of range"
                          className="absolute right-2 top-1/2 size-2 -translate-y-1/2 rounded-full bg-status-high"
                        />
                      )}
                    </div>
                    <UnitCombobox
                      value={row.unit}
                      placeholder="—"
                      onChange={(unit) => updateRow(cat.id, row.id, 'unit', unit)}
                    />
                    <RangeInput
                      value={row.range}
                      onChange={(v) => updateRow(cat.id, row.id, 'range', v)}
                    />
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
