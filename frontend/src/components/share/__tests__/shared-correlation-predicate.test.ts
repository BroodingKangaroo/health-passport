import { describe, expect, it, vi } from 'vitest'

// These are two pure predicates; nothing here renders. Mocking the charting
// library keeps the module graph light and says out loud that this test is
// about a rule, not a chart.
vi.mock('recharts', () => ({}))

import { hasReadings as chartHasReadings } from '@/components/health-passport/correlation-chart'
import { hasReadings as sharedHasReadings } from '@/components/share/SharedCorrelation'
import type { BiomarkerDefinition, BiomarkerResult } from '@/lib/types'

/**
 * ST3 duplicates `hasReadings` on purpose — importing it from
 * `correlation-chart.tsx` would drag the chart, and recharts, into the shared
 * tree's EAGER graph, which is the one thing the correlation section exists to
 * avoid. The duplication is acceptable only while the two agree, so this pins
 * that. It costs no bundle: this module is imported by tests only, and the
 * graph walker starts from `ROOTS`, not from here.
 */
const definition: BiomarkerDefinition = {
  id: 'hb',
  names: { en: 'Hemoglobin', ru: 'Гемоглобин' },
  synonyms: [],
  unit: 'g/dL',
  category: 'Blood',
  scope: 'global',
  reference: { kind: 'interval', low: 12, high: 16 },
  reference_source: 'global',
}

const base = {
  id: 'hb',
  entry_id: 'blood-1',
  definition,
  date: '2026-01-12T00:00:00+00:00',
}

const CASES: { name: string; biomarker: BiomarkerResult }[] = [
  {
    name: 'no history and no value',
    biomarker: { ...base, value: null, status: '', history: [] },
  },
  {
    name: 'a value only',
    biomarker: { ...base, value: 10.2, status: 'low', history: [] },
  },
  {
    name: 'a history only',
    biomarker: {
      ...base,
      value: null,
      status: '',
      history: [{ entry_id: 'blood-0', date: '2025-01-01T00:00:00+00:00', value: 13, status: 'normal' }],
    },
  },
  {
    name: 'both a value and a history',
    biomarker: {
      ...base,
      value: 10.2,
      status: 'low',
      history: [{ entry_id: 'blood-0', date: '2025-01-01T00:00:00+00:00', value: 13, status: 'normal' }],
    },
  },
  {
    name: 'a qualitative value with no history',
    biomarker: { ...base, value: 'Not detected', status: 'normal', history: [] },
  },
  {
    name: 'a value of zero',
    biomarker: { ...base, value: 0, status: 'low', history: [] },
  },
  {
    name: 'an unreadable value',
    biomarker: { ...base, value: 'см.комм.', status: '', history: [] },
  },
]

describe('the duplicated hasReadings predicate', () => {
  it.each(CASES)('agrees with the chart module on $name', ({ biomarker }) => {
    expect(sharedHasReadings(biomarker)).toBe(chartHasReadings(biomarker))
  })
})
