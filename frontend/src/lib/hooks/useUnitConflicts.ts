'use client'

import { useState, useCallback } from 'react'

import type { FormBiomarkerRow, Reference, UnitConflict } from '@/lib/types'

type UpdateRow = (
  catId: string,
  rowId: string,
  key: keyof FormBiomarkerRow,
  val: string | Reference | null,
) => void

// Holds the unit conflicts detected right after an AI extraction and applies
// the dialog's resolutions: "Keep document unit" rewrites the form row back
// to the raw value/unit (it does NOT change the stored definition's canonical
// unit); converted rows are left as extracted.
export function useUnitConflicts(updateRow: UpdateRow) {
  const [unitConflicts, setUnitConflicts] = useState<UnitConflict[]>([])

  const detect = useCallback((conflicts: UnitConflict[]) => {
    setUnitConflicts(conflicts)
  }, [])

  const applyResolutions = useCallback(
    (resolved: UnitConflict[]) => {
      for (const c of resolved) {
        if (!c.keepConverted) {
          updateRow(c.catId, c.rowId, 'value', c.originalValue)
          updateRow(c.catId, c.rowId, 'unit', c.originalUnit)
        }
      }
      setUnitConflicts([])
    },
    [updateRow],
  )

  return { unitConflicts, detect, applyResolutions }
}
