'use client'

import { Plus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { FormCategory, FormBiomarkerRow } from '@/lib/types'

function isOutOfRange(value: string, range: string) {
  const v = Number.parseFloat(value)
  const m = range.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/)
  if (Number.isNaN(v) || !m) return false
  const lo = Number.parseFloat(m[1])
  const hi = Number.parseFloat(m[2])
  return v < lo || v > hi
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
              <div className="grid grid-cols-[1.4fr_0.9fr_0.7fr_1fr_36px] items-center gap-x-2 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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
                    className="grid grid-cols-[1.4fr_0.9fr_0.7fr_1fr_36px] items-center gap-x-2 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <Input
                      value={row.name}
                      placeholder="Name"
                      onChange={(e) =>
                        updateRow(cat.id, row.id, 'name', e.target.value)
                      }
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
                    <Input
                      value={row.unit}
                      placeholder="—"
                      onChange={(e) =>
                        updateRow(cat.id, row.id, 'unit', e.target.value)
                      }
                    />
                    <Input
                      value={row.range}
                      placeholder="—"
                      onChange={(e) =>
                        updateRow(cat.id, row.id, 'range', e.target.value)
                      }
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
