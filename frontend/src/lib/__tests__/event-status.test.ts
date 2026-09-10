import { describe, it, expect } from 'vitest'
import { hasFlagged, statusCountsAtEvent, statusCountsByEvent } from '../event-status'
import type { BiomarkerResult } from '../types'

const EVT = 'evt-1'

function makeBiomarker(overrides: Partial<BiomarkerResult>): BiomarkerResult {
  return {
    id: 'hb',
    entry_id: EVT,
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

describe('statusCountsAtEvent', () => {
  it('counts flagged readings matched by entry id from history and top-level', () => {
    const biomarkers = [
      makeBiomarker({ id: 'a', status: 'high' }),
      makeBiomarker({
        id: 'b',
        entry_id: 'evt-2',
        status: 'normal',
        history: [{ entry_id: EVT, date: '2026-01-01', value: 1, status: 'low' }],
      }),
      makeBiomarker({ id: 'c', status: 'abnormal' }),
      makeBiomarker({ id: 'd', status: 'normal' }),
    ]

    expect(statusCountsAtEvent(biomarkers, EVT)).toEqual({ low: 1, high: 1, abnormal: 1 })
  })

  it('ignores unknown statuses and biomarkers with no reading at the event', () => {
    const biomarkers = [
      makeBiomarker({ status: '' as unknown as BiomarkerResult['status'] }),
      makeBiomarker({ entry_id: 'evt-2', status: 'high' }),
    ]

    expect(statusCountsAtEvent(biomarkers, EVT)).toEqual({ low: 0, high: 0, abnormal: 0 })
  })

  it('takes the first matching reading, history before the top-level one', () => {
    const b = makeBiomarker({
      status: 'high',
      history: [{ entry_id: EVT, date: '2026-01-01', value: 1, status: 'normal' }],
    })

    expect(statusCountsAtEvent([b], EVT)).toEqual({ low: 0, high: 0, abnormal: 0 })
  })
})

describe('hasFlagged', () => {
  it('is false for undefined/empty counts and true for any non-zero count', () => {
    expect(hasFlagged(undefined)).toBe(false)
    expect(hasFlagged({ low: 0, high: 0, abnormal: 0 })).toBe(false)
    expect(hasFlagged({ low: 1, high: 0, abnormal: 0 })).toBe(true)
    expect(hasFlagged({ low: 0, high: 2, abnormal: 0 })).toBe(true)
    expect(hasFlagged({ low: 0, high: 0, abnormal: 1 })).toBe(true)
  })
})

describe('statusCountsByEvent', () => {
  it('maps every event id to its counts', () => {
    const biomarkers = [
      makeBiomarker({ status: 'high' }),
      makeBiomarker({ id: 'b', entry_id: 'evt-2', status: 'low' }),
    ]

    const map = statusCountsByEvent(biomarkers, ['evt-1', 'evt-2', 'evt-3'])

    expect(map.get('evt-1')).toEqual({ low: 0, high: 1, abnormal: 0 })
    expect(map.get('evt-2')).toEqual({ low: 1, high: 0, abnormal: 0 })
    expect(map.get('evt-3')).toEqual({ low: 0, high: 0, abnormal: 0 })
  })
})
