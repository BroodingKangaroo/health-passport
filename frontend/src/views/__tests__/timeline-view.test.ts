import { describe, it, expect, vi } from 'vitest'
import { biomarkersAtDate } from '@/views/TimelineView'
import type { BiomarkerResult } from '@/lib/types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

function makeBiomarker(overrides: Partial<BiomarkerResult>): BiomarkerResult {
  return {
    id: 'hb',
    definition: {
      id: 'hb',
      names: { en: 'Hemoglobin', ru: 'Гемоглобин' },
      synonyms: [],
      category: 'Complete Blood Count',
      unit: 'g/L',
      reference: null,
      scope: 'global',
      reference_source: 'global',
    },
    value: 150,
    date: '2026-07-15T00:00:00',
    status: 'normal',
    ...overrides,
  }
}

describe('biomarkersAtDate', () => {
  it('returns the full list when no date is given', () => {
    const b = makeBiomarker({})
    expect(biomarkersAtDate([b], '')).toHaveLength(1)
  })

  it('drops biomarkers with no reading at the given date', () => {
    const b = makeBiomarker({
      date: '2026-03-01T00:00:00',
      history: [{ date: '2026-01-01T00:00:00', value: 140, status: 'normal' }],
    })
    expect(biomarkersAtDate([b], '2026-07-15T00:00:00')).toHaveLength(0)
  })

  it('uses the latest-reading merged flag for the latest event', () => {
    const b = makeBiomarker({
      merged: true,
      merged_source: { title: 'Evening Panel', clinic: 'Lab B', time: '18:30' },
      history: [
        { date: '2026-01-01T00:00:00', value: 140, status: 'normal', merged: false },
      ],
    })
    const atLatest = biomarkersAtDate([b], '2026-07-15T00:00:00')[0]
    expect(atLatest.merged).toBe(true)
    expect(atLatest.merged_source).toEqual({ title: 'Evening Panel', clinic: 'Lab B', time: '18:30' })
  })

  it('uses the per-reading flag for an older merged event, not the latest one', () => {
    const b = makeBiomarker({
      // Latest reading is a NEWER, separate, unmerged test.
      merged: false,
      merged_source: null,
      history: [
        { date: '2026-01-01T00:00:00', value: 140, status: 'normal', merged: true, merged_source: { title: 'Evening Panel', clinic: 'Lab B' } },
        { date: '2026-02-01T00:00:00', value: 141, status: 'normal', merged: false, merged_source: null },
      ],
    })
    const atMergedEvent = biomarkersAtDate([b], '2026-01-01T00:00:00')[0]
    expect(atMergedEvent.merged).toBe(true)
    expect(atMergedEvent.merged_source).toEqual({ title: 'Evening Panel', clinic: 'Lab B' })

    const atNewerEvent = biomarkersAtDate([b], '2026-02-01T00:00:00')[0]
    expect(atNewerEvent.merged).toBe(false)
    expect(atNewerEvent.merged_source).toBe(null)
  })

  it('does not fall back to the latest merged_source for an unmerged older reading', () => {
    // The reading at the older event is unmerged but the latest reading IS
    // merged — the older event must still show no source.
    const b = makeBiomarker({
      merged: true,
      merged_source: { title: 'Later Panel' },
      history: [
        { date: '2026-01-01T00:00:00', value: 140, status: 'normal', merged: false, merged_source: null },
      ],
    })
    const atOlderEvent = biomarkersAtDate([b], '2026-01-01T00:00:00')[0]
    expect(atOlderEvent.merged).toBe(false)
    expect(atOlderEvent.merged_source).toBe(null)
  })

  it('keeps the remaining history when targeting a middle event', () => {
    const b = makeBiomarker({
      history: [
        { date: '2026-01-01T00:00:00', value: 140, status: 'normal' },
        { date: '2026-02-01T00:00:00', value: 141, status: 'normal' },
      ],
    })
    const atMiddle = biomarkersAtDate([b], '2026-02-01T00:00:00')[0]
    expect(atMiddle.history?.map((h) => h.date)).toEqual([
      '2026-01-01T00:00:00',
      '2026-07-15T00:00:00',
    ])
  })
})
