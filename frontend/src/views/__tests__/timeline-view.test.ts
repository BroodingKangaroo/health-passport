import { describe, it, expect, vi } from 'vitest'
import { biomarkersAtDate } from '@/views/TimelineView'
import type { BiomarkerResult } from '@/lib/types'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

// The latest reading lives at event EVT_LATEST (top-level fields); history
// readings live at their own entry ids.
const EVT_LATEST = 'evt-latest'

function makeBiomarker(overrides: Partial<BiomarkerResult>): BiomarkerResult {
  return {
    id: 'hb',
    entry_id: EVT_LATEST,
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
  it('returns the full list when no event id is given', () => {
    const b = makeBiomarker({})
    expect(biomarkersAtDate([b], '')).toHaveLength(1)
  })

  it('drops biomarkers with no reading at the given event', () => {
    const b = makeBiomarker({
      // The top-level reading lives at a different event than the selected
      // one — no reading exists at EVT_LATEST, so it must be dropped.
      entry_id: 'evt-other',
      date: '2026-03-01T00:00:00',
      history: [{ entry_id: 'evt-old', date: '2026-01-01T00:00:00', value: 140, status: 'normal' }],
    })
    expect(biomarkersAtDate([b], EVT_LATEST)).toHaveLength(0)
  })

  it('uses the latest-reading merged flag for the latest event', () => {
    const b = makeBiomarker({
      merged: true,
      merged_source: { title: 'Evening Panel', clinic: 'Lab B', time: '18:30' },
      history: [
        { entry_id: 'evt-old', date: '2026-01-01T00:00:00', value: 140, status: 'normal', merged: false },
      ],
    })
    const atLatest = biomarkersAtDate([b], EVT_LATEST)[0]
    expect(atLatest.merged).toBe(true)
    expect(atLatest.merged_source).toEqual({ title: 'Evening Panel', clinic: 'Lab B', time: '18:30' })
  })

  it('uses the per-reading flag for an older merged event, not the latest one', () => {
    const b = makeBiomarker({
      // Latest reading is a NEWER, separate, unmerged test.
      merged: false,
      merged_source: null,
      history: [
        { entry_id: 'evt-old', date: '2026-01-01T00:00:00', value: 140, status: 'normal', merged: true, merged_source: { title: 'Evening Panel', clinic: 'Lab B' } },
        { entry_id: 'evt-mid', date: '2026-02-01T00:00:00', value: 141, status: 'normal', merged: false, merged_source: null },
      ],
    })
    const atMergedEvent = biomarkersAtDate([b], 'evt-old')[0]
    expect(atMergedEvent.merged).toBe(true)
    expect(atMergedEvent.merged_source).toEqual({ title: 'Evening Panel', clinic: 'Lab B' })

    const atNewerEvent = biomarkersAtDate([b], 'evt-mid')[0]
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
        { entry_id: 'evt-old', date: '2026-01-01T00:00:00', value: 140, status: 'normal', merged: false, merged_source: null },
      ],
    })
    const atOlderEvent = biomarkersAtDate([b], 'evt-old')[0]
    expect(atOlderEvent.merged).toBe(false)
    expect(atOlderEvent.merged_source).toBe(null)
  })

  it('keeps the remaining history when targeting a middle event', () => {
    const b = makeBiomarker({
      history: [
        { entry_id: 'evt-first', date: '2026-01-01T00:00:00', value: 140, status: 'normal' },
        { entry_id: 'evt-mid', date: '2026-02-01T00:00:00', value: 141, status: 'normal' },
      ],
    })
    const atMiddle = biomarkersAtDate([b], 'evt-mid')[0]
    expect(atMiddle.history?.map((h) => h.date)).toEqual([
      '2026-01-01T00:00:00',
      '2026-07-15T00:00:00',
    ])
  })

  it('shows the metadata of the reading AT the event, not the newest doc, for an older event', () => {
    const b = makeBiomarker({
      original_name: 'Hemoglobin (latest)',
      original_value: '15.0',
      original_unit: 'g/dL',
      original_range: '13-17',
      reference: { kind: 'interval', low: 130, high: 170 },
      history: [
        {
          entry_id: 'evt-old',
          date: '2026-01-01T00:00:00',
          value: 140,
          status: 'normal',
          original_name: 'Hb (old doc)',
          original_value: '14.0',
          original_unit: 'g/dl',
          original_range: '12-16',
          reference: { kind: 'interval', low: 120, high: 160 },
        },
      ],
    })
    const atOlderEvent = biomarkersAtDate([b], 'evt-old')[0]
    expect(atOlderEvent.original_name).toBe('Hb (old doc)')
    expect(atOlderEvent.original_value).toBe('14.0')
    expect(atOlderEvent.original_unit).toBe('g/dl')
    expect(atOlderEvent.original_range).toBe('12-16')
    expect(atOlderEvent.reference).toEqual({ kind: 'interval', low: 120, high: 160 })
  })

  it('keeps the top-level metadata for the latest event', () => {
    const b = makeBiomarker({
      original_name: 'Hemoglobin (latest)',
      original_value: '15.0',
      original_unit: 'g/dL',
      original_range: '13-17',
      reference: { kind: 'interval', low: 130, high: 170 },
      history: [
        {
          entry_id: 'evt-old',
          date: '2026-01-01T00:00:00',
          value: 140,
          status: 'normal',
          original_name: 'Hb (old doc)',
          original_value: '14.0',
          original_unit: 'g/dl',
          original_range: '12-16',
          reference: { kind: 'interval', low: 120, high: 160 },
        },
      ],
    })
    const atLatest = biomarkersAtDate([b], EVT_LATEST)[0]
    expect(atLatest.original_name).toBe('Hemoglobin (latest)')
    expect(atLatest.original_value).toBe('15.0')
    expect(atLatest.original_unit).toBe('g/dL')
    expect(atLatest.original_range).toBe('13-17')
    expect(atLatest.reference).toEqual({ kind: 'interval', low: 130, high: 170 })
  })

  it('shows the metadata of the middle reading when targeting a middle event', () => {
    const b = makeBiomarker({
      original_name: 'Latest name',
      reference: { kind: 'interval', low: 130, high: 170 },
      history: [
        {
          entry_id: 'evt-first',
          date: '2026-01-01T00:00:00',
          value: 140,
          status: 'normal',
          original_name: 'First name',
          reference: { kind: 'interval', low: 120, high: 160 },
        },
        {
          entry_id: 'evt-mid',
          date: '2026-02-01T00:00:00',
          value: 141,
          status: 'normal',
          original_name: 'Middle name',
          reference: { kind: 'interval', low: 125, high: 165 },
        },
      ],
    })
    const atMiddle = biomarkersAtDate([b], 'evt-mid')[0]
    expect(atMiddle.original_name).toBe('Middle name')
    expect(atMiddle.reference).toEqual({ kind: 'interval', low: 125, high: 165 })
  })

  it('does not inherit the latest reference when the older reading has none', () => {
    const b = makeBiomarker({
      reference: { kind: 'interval', low: 130, high: 170 },
      history: [
        { entry_id: 'evt-old', date: '2026-01-01T00:00:00', value: 140, status: 'normal', reference: null },
      ],
    })
    const atOlderEvent = biomarkersAtDate([b], 'evt-old')[0]
    expect(atOlderEvent.reference).toBeNull()
  })

  it('matches the reading of the selected same-day event, not the first one', () => {
    // Two unmerged tests on the SAME date (the issue-16 scenario): the second
    // event must show its own value/merged flags, never the first event's.
    const b = makeBiomarker({
      value: 150,
      date: '2026-07-15T00:00:00',
      status: 'normal',
      merged: false,
      merged_source: null,
      history: [
        {
          entry_id: 'evt-morning',
          date: '2026-07-15T00:00:00',
          value: 120,
          status: 'low',
          merged: true,
          merged_source: { title: 'Morning Panel', clinic: 'Lab A', time: '09:00' },
        },
      ],
    })
    const atMorning = biomarkersAtDate([b], 'evt-morning')[0]
    expect(atMorning.value).toBe(120)
    expect(atMorning.status).toBe('low')
    expect(atMorning.merged).toBe(true)
    expect(atMorning.merged_source).toEqual({ title: 'Morning Panel', clinic: 'Lab A', time: '09:00' })

    const atLatest = biomarkersAtDate([b], EVT_LATEST)[0]
    expect(atLatest.value).toBe(150)
    expect(atLatest.status).toBe('normal')
    expect(atLatest.merged).toBe(false)
    expect(atLatest.merged_source).toBe(null)
  })

  it('keeps both same-day readings in the remaining history when targeting one of them', () => {
    const b = makeBiomarker({
      history: [
        { entry_id: 'evt-morning', date: '2026-07-15T00:00:00', value: 120, status: 'low' },
        { entry_id: 'evt-other-day', date: '2026-07-01T00:00:00', value: 130, status: 'normal' },
      ],
    })
    const atMorning = biomarkersAtDate([b], 'evt-morning')[0]
    expect(atMorning.history?.map((h) => h.entry_id)).toEqual(['evt-other-day', EVT_LATEST])
  })
})
