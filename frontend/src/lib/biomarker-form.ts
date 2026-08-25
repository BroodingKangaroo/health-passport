import type {
  ExtractedInstrumentalData,
  ExtractedVisitData,
  FormBiomarkerRow,
  FormCategory,
  StandardizedBiomarker,
  UnitConflict,
} from '@/lib/types'

export function newRow(): FormBiomarkerRow {
  return {
    id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    value: '',
    unit: '',
    reference: null,
  }
}

export function manualCategories(): FormCategory[] {
  return [{ id: 'cat-1', name: 'General', rows: [newRow()] }]
}

export function biomarkersToCategories(biomarkers: StandardizedBiomarker[]): FormCategory[] {
  const grouped: Record<string, StandardizedBiomarker[]> = {}
  for (const b of biomarkers) {
    const cat = b.category || 'General'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(b)
  }
  return Object.entries(grouped).map(([name, rows]) => ({
    id: `ai-cat-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    rows: rows.map((r) => ({
      id: `ai-bm-${r.standard_name_en.toLowerCase().replace(/\s+/g, '-')}-${Math.random().toString(36).slice(2, 4)}`,
      name: r.standard_name_en,
      value: r.standard_value == null ? '' : String(r.standard_value),
      unit: r.reference?.kind === 'qualitative' ? 'Qualitative' : r.standard_unit,
      reference: r.reference ?? null,
      original_name: r.raw_name,
      original_value: r.raw_value,
      original_unit: r.raw_unit,
      original_range: r.raw_range_string,
      definition_id: r.definition_id,
      scope: r.scope,
      canonical_unit_inferred: r.canonical_unit_inferred,
    })),
  }))
}

// True when the editor currently holds data a fresh AI extraction would wipe:
// any filled biomarker row, or extracted visit/instrumental content. Only
// form content is checked — pre-filled metadata (clinic/title/notes) is
// considered cheap to re-derive, not worth a confirmation on its own.
export function hasFormData(
  documentType: string,
  categories: FormCategory[],
  visitData: ExtractedVisitData | null,
  instrumentalData: ExtractedInstrumentalData | null,
): boolean {
  if (documentType === 'doctor_visit') return visitData != null
  if (documentType === 'instrumental_test') return instrumentalData != null
  return categories.some((c) =>
    c.rows.some((r) => r.name.trim() !== '' || r.value.trim() !== ''),
  )
}

// Detect unit conflicts (biomarkers where cross-scale conversion was applied):
// a converted biomarker matches back to its form row via the raw name+unit the
// row kept, so "Keep document unit" can rewrite exactly that row.
export function buildUnitConflicts(
  biomarkers: StandardizedBiomarker[],
  cats: FormCategory[],
): UnitConflict[] {
  const conflicts: UnitConflict[] = []
  for (const bm of biomarkers) {
    if (bm.scale_function) {
      for (const cat of cats) {
        for (const row of cat.rows) {
          if (row.original_name === bm.raw_name && row.original_unit === bm.raw_unit) {
            conflicts.push({
              catId: cat.id,
              rowId: row.id,
              name: bm.standard_name_en,
              rawUnit: bm.raw_unit,
              standardUnit: bm.standard_unit,
              scaleFunction: bm.scale_function,
              keepConverted: true,
              originalValue: row.original_value ?? '',
              originalUnit: row.original_unit ?? '',
            })
          }
        }
      }
    }
  }
  return conflicts
}
