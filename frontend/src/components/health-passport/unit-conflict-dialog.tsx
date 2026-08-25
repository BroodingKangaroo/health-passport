'use client'

import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { UnitConflict } from '@/lib/types'

export type { UnitConflict }

export function UnitConflictDialog({
  conflicts,
  onResolve,
}: {
  conflicts: UnitConflict[]
  onResolve: (conflicts: UnitConflict[]) => void
}) {
  const [choices, setChoices] = useState<Record<string, boolean>>(
    Object.fromEntries(conflicts.map((c) => [c.rowId, true])),
  )

  if (conflicts.length === 0) return null

  const scaleLabel = (fn: string) => {
    if (fn === '10^x') return '10^value (log10 → linear)'
    if (fn === 'log10') return 'log10(value) (linear → log10)'
    if (fn.startsWith('factor:')) return `× ${fn.slice(7)}`
    if (fn === 'exp(x)') return 'e^value (ln → linear)'
    return fn
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-lg rounded-xl bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Unit Conversion Detected
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Some biomarkers in this document use a different unit than what was
              previously recorded. Choose how to handle each one.
            </p>
          </div>
        </div>

        <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
          {conflicts.map((c) => (
            <div
              key={c.rowId}
              className="rounded-lg border border-border p-3 text-sm"
            >
              <p className="font-medium text-foreground">{c.name}</p>
              <div className="mt-1.5 space-y-1 text-xs text-muted-foreground">
                <p>Document reports in: <span className="font-mono text-foreground">{c.rawUnit}</span></p>
                <p>Previously stored as: <span className="font-mono text-foreground">{c.standardUnit}</span></p>
                <p>Applied conversion: <span className="font-mono text-foreground">{scaleLabel(c.scaleFunction)}</span></p>
              </div>
              <div className="mt-2 flex items-center gap-4">
                <label className="flex items-center gap-1.5 text-xs text-foreground">
                  <input
                    type="radio"
                    name={`conflict-${c.rowId}`}
                    checked={choices[c.rowId] !== false}
                    onChange={() => setChoices((p) => ({ ...p, [c.rowId]: true }))}
                    className="size-3.5 accent-primary"
                  />
                  Use converted value
                </label>
                <label className="flex items-center gap-1.5 text-xs text-foreground">
                  <input
                    type="radio"
                    name={`conflict-${c.rowId}`}
                    checked={choices[c.rowId] === false}
                    onChange={() => setChoices((p) => ({ ...p, [c.rowId]: false }))}
                    className="size-3.5 accent-primary"
                  />
                  Keep document unit
                </label>
              </div>
              {choices[c.rowId] === false && (
                <p className="mt-1.5 text-xs text-amber-600">
                  Keeping the document unit will make this biomarker&apos;s graph unusable because values will be in a different scale from previously recorded data.
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() =>
              onResolve(
                conflicts.map((c) => ({ ...c, keepConverted: true })),
              )
            }
          >
            Convert all
          </Button>
          <Button
            onClick={() =>
              onResolve(
                conflicts.map((c) => ({
                  ...c,
                  keepConverted: choices[c.rowId] !== false,
                })),
              )
            }
          >
            Apply
          </Button>
        </div>
      </div>
    </div>
  )
}
