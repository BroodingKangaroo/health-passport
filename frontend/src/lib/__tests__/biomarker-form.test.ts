import { describe, it, expect } from 'vitest'
import {
  newRow,
  manualCategories,
  biomarkersToCategories,
  buildUnitConflicts,
  hasFormData,
} from '@/lib/biomarker-form'
import type {
  ExtractedInstrumentalData,
  ExtractedVisitData,
  StandardizedBiomarker,
} from '@/lib/types'

function biomarker(overrides: Partial<StandardizedBiomarker> = {}): StandardizedBiomarker {
  return {
    raw_name: 'Hemoglobin',
    raw_value: '145',
    raw_unit: 'g/L',
    raw_range_string: '130-170',
    standard_name_en: 'Hemoglobin',
    standard_value: 145,
    standard_unit: 'g/L',
    reference: { kind: 'interval', low: 130, high: 170 },
    status: 'normal',
    category: 'Complete Blood Count',
    definition_id: 'hb',
    scope: 'global',
    ...overrides,
  }
}

describe('newRow / manualCategories', () => {
  it('creates an empty row with a unique id and no reference', () => {
    const a = newRow()
    const b = newRow()
    expect(a.id).toMatch(/^bm-/)
    expect(b.id).not.toBe(a.id)
    expect(a).toMatchObject({ name: '', value: '', unit: '', reference: null })
  })

  it('starts manual mode with one General category holding one empty row', () => {
    const cats = manualCategories()
    expect(cats).toHaveLength(1)
    expect(cats[0].name).toBe('General')
    expect(cats[0].rows).toHaveLength(1)
    expect(cats[0].rows[0].name).toBe('')
  })
})

describe('biomarkersToCategories', () => {
  it('groups biomarkers by category preserving order', () => {
    const cats = biomarkersToCategories([
      biomarker(),
      biomarker({ standard_name_en: 'WBC', definition_id: 'wbc' }),
      biomarker({
        standard_name_en: 'LDL',
        definition_id: 'ldl',
        category: 'Lipid Panel',
      }),
    ])
    expect(cats.map((c) => c.name)).toEqual(['Complete Blood Count', 'Lipid Panel'])
    expect(cats[0].rows.map((r) => r.name)).toEqual(['Hemoglobin', 'WBC'])
    expect(cats[1].rows.map((r) => r.name)).toEqual(['LDL'])
  })

  it('falls back to the General category for blank categories', () => {
    const cats = biomarkersToCategories([biomarker({ category: '' })])
    expect(cats).toHaveLength(1)
    expect(cats[0].name).toBe('General')
  })

  it('labels qualitative references with a Qualitative unit', () => {
    const cats = biomarkersToCategories([
      biomarker({
        reference: { kind: 'qualitative', expected: 'Negative' },
        standard_unit: '',
      }),
    ])
    expect(cats[0].rows[0].unit).toBe('Qualitative')
  })

  it('keeps the standard unit for interval references', () => {
    const cats = biomarkersToCategories([biomarker()])
    expect(cats[0].rows[0].unit).toBe('g/L')
  })

  it('maps null standard values to an empty string and carries original fields', () => {
    const cats = biomarkersToCategories([
      biomarker({ standard_value: null, canonical_unit_inferred: true }),
    ])
    const row = cats[0].rows[0]
    expect(row.value).toBe('')
    expect(row).toMatchObject({
      original_name: 'Hemoglobin',
      original_value: '145',
      original_unit: 'g/L',
      original_range: '130-170',
      definition_id: 'hb',
      scope: 'global',
      canonical_unit_inferred: true,
    })
    expect(row.reference).toEqual({ kind: 'interval', low: 130, high: 170 })
  })
})

describe('hasFormData', () => {
  it('is false for a blank blood-test form, true once a row has a name or value', () => {
    expect(hasFormData('blood_test', manualCategories(), null, null)).toBe(false)

    const withName = manualCategories()
    withName[0].rows[0].name = 'Hemoglobin'
    expect(hasFormData('blood_test', withName, null, null)).toBe(true)

    const withValue = manualCategories()
    withValue[0].rows[0].value = '145'
    expect(hasFormData('blood_test', withValue, null, null)).toBe(true)

    const whitespaceOnly = manualCategories()
    whitespaceOnly[0].rows[0].name = '   '
    expect(hasFormData('blood_test', whitespaceOnly, null, null)).toBe(false)
  })

  it('checks any row across all categories', () => {
    const cats = manualCategories()
    cats.push({ id: 'cat-2', name: 'Liver', rows: [newRow(), newRow()] })
    cats[1].rows[1].value = '7'
    expect(hasFormData('blood_test', cats, null, null)).toBe(true)
  })

  it('keys on the companion payload for doctor visits and instrumental tests', () => {
    expect(hasFormData('doctor_visit', manualCategories(), null, null)).toBe(false)
    expect(
      hasFormData('doctor_visit', manualCategories(), {
        diagnosis: { original: 'Hypertension', translated_en: 'Hypertension' },
      } as ExtractedVisitData, null),
    ).toBe(true)

    expect(hasFormData('instrumental_test', manualCategories(), null, null)).toBe(false)
    expect(
      hasFormData('instrumental_test', manualCategories(), null, {
        modality: 'MRI',
      } as ExtractedInstrumentalData),
    ).toBe(true)
  })
})

describe('buildUnitConflicts', () => {
  it('ignores biomarkers without a scale function', () => {
    const cats = biomarkersToCategories([biomarker()])
    expect(buildUnitConflicts([biomarker()], cats)).toEqual([])
  })

  it('matches converted biomarkers back to their rows via raw name+unit', () => {
    const bm = biomarker({ scale_function: 'log10' })
    const cats = biomarkersToCategories([bm])
    const conflicts = buildUnitConflicts([bm], cats)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      catId: cats[0].id,
      rowId: cats[0].rows[0].id,
      name: 'Hemoglobin',
      rawUnit: 'g/L',
      standardUnit: 'g/L',
      scaleFunction: 'log10',
      keepConverted: true,
      originalValue: '145',
      originalUnit: 'g/L',
    })
  })

  it('does not match rows whose raw name or unit differs', () => {
    const bm = biomarker({ scale_function: 'factor:10' })
    const cats = biomarkersToCategories([bm])
    const other = biomarkersToCategories([
      biomarker({ raw_name: 'Different', scale_function: 'factor:10' }),
    ])
    expect(buildUnitConflicts([bm], other)).toEqual([])
    // Same name, different raw unit — no match either.
    const renamed = [{ ...bm, raw_unit: 'mmol/L' }]
    expect(buildUnitConflicts(renamed, cats)).toEqual([])
  })
})
