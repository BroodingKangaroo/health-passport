import { describe, expect, it } from 'vitest'
import { buildDemoTimeline, DEMO_BT1_ID, DEMO_BT2_ID, DEMO_VISIT_ID } from '../demo-data'
import type { BiomarkerResult, Reference } from '@/lib/types'

// Fixed anchor so day offsets are deterministic in assertions.
const NOW = new Date('2026-09-03T12:00:00Z')

/** Mirrors backend `compute_status` semantics for the fixture's references. */
function expectedStatus(value: number | string | null, ref: Reference | null | undefined): string {
  if (!ref) return ''
  if (ref.kind === 'interval') {
    if (typeof value !== 'number') return ''
    if (ref.low != null && value < ref.low) return 'low'
    if (ref.high != null && value > ref.high) return 'high'
    return 'normal'
  }
  if (typeof value !== 'string') return ''
  return value === ref.expected ? 'normal' : 'abnormal'
}

function allReadings(b: BiomarkerResult) {
  return [
    ...(b.history ?? []).map((r) => ({ value: r.value, status: r.status, reference: r.reference })),
    { value: b.value, status: b.status, reference: b.reference ?? b.definition.reference },
  ]
}

describe('demo fixture', () => {
  const timeline = buildDemoTimeline('en', NOW)

  it('has three events in ascending date order (two blood tests + one visit)', () => {
    expect(timeline.events.map((e) => e.id)).toEqual([DEMO_BT1_ID, DEMO_VISIT_ID, DEMO_BT2_ID])
    const dates = timeline.events.map((e) => new Date(e.date).getTime())
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1])
    }
  })

  it('relativizes dates around now (never ages)', () => {
    const bt1 = timeline.events.find((e) => e.id === DEMO_BT1_ID)!
    expect(bt1.date).toBe('2026-07-20')
    const bt2 = timeline.events.find((e) => e.id === DEMO_BT2_ID)!
    expect(bt2.date).toBe('2026-08-31')
  })

  it('every reading status is consistent with its value and reference', () => {
    for (const b of timeline.biomarkers) {
      for (const r of allReadings(b)) {
        expect(expectedStatus(r.value, r.reference), `${b.id}`).toBe(r.status)
      }
    }
  })

  it('exercises the full status model (low, normal, high, abnormal all present)', () => {
    const statuses = new Set<string>()
    for (const b of timeline.biomarkers) {
      for (const r of allReadings(b)) statuses.add(r.status)
    }
    expect(statuses.has('low')).toBe(true)
    expect(statuses.has('normal')).toBe(true)
    expect(statuses.has('high')).toBe(true)
    expect(statuses.has('abnormal')).toBe(true)
  })

  it('definitions are bilingual and history links only demo entries', () => {
    const eventIds = new Set(timeline.events.map((e) => e.id))
    for (const b of timeline.biomarkers) {
      expect(b.definition.names.en.trim()).not.toBe('')
      expect(b.definition.names.ru.trim()).not.toBe('')
      expect(eventIds.has(b.entry_id)).toBe(true)
      for (const r of b.history ?? []) {
        expect(eventIds.has(r.entry_id)).toBe(true)
      }
    }
  })

  it('the narrative arc: H. pylori abnormal at bt1, normal at bt2 (treated at the visit)', () => {
    const hp = timeline.biomarkers.find((b) => b.id === 'demo-h-pylori')!
    expect(hp.history).toHaveLength(1)
    expect(hp.history![0].status).toBe('abnormal')
    expect(hp.status).toBe('normal')
  })

  it('visit data is fictional and bilingual', () => {
    const visit = timeline.visits[DEMO_VISIT_ID]
    expect(visit.specialty.trim()).not.toBe('')
    expect(visit.verdict.original.trim()).not.toBe('')
    expect(visit.verdict.translated_en.trim()).not.toBe('')
    expect(visit.notes.length).toBeGreaterThan(0)
    expect(visit.prescriptions.length).toBeGreaterThan(0)
    expect(visit.recommendations.length).toBeGreaterThan(0)
  })

  it('RU and EN builds contain the same events and biomarker ids', () => {
    const ru = buildDemoTimeline('ru', NOW)
    expect(ru.events.map((e) => e.id)).toEqual(timeline.events.map((e) => e.id))
    expect(ru.biomarkers.map((b) => b.id)).toEqual(timeline.biomarkers.map((b) => b.id))
  })

  it('contains no real-world data markers (fixture is fully fictional)', () => {
    const blob = JSON.stringify(timeline)
    // The maintainer's real e2e documents use real clinic/doctor strings;
    // none of them may leak into the demo fixture.
    for (const forbidden of ['ргц', 'РГЦ', 'Гастроэнтеролог РГЦ']) {
      expect(blob).not.toContain(forbidden)
    }
  })
})
