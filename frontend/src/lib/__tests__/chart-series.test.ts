import { describe, expect, it } from 'vitest'

import {
  axisDateLabel,
  buildTimeAxis,
  dateTickFormatter,
  tickLabel,
} from '../chart-series'
import { readingEpoch, sortReadingsByDate } from '../utils'

const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m, d, h, min).getTime()

describe('readingEpoch', () => {
  it('returns epoch ms for an ISO date string', () => {
    expect(readingEpoch('2024-01-01T12:00:00')).toBe(at(2024, 0, 1))
  })

  it('falls back to a finite 0 for an unparseable date', () => {
    expect(readingEpoch('not-a-date')).toBe(0)
  })

  it('matches the ordering sortReadingsByDate applies', () => {
    const readings = [
      { date: '2024-02-01T12:00:00' },
      { date: 'not-a-date' },
      { date: '2024-01-01T12:00:00' },
    ]
    const sorted = sortReadingsByDate(readings)
    const epochs = sorted.map((r) => readingEpoch(r.date))
    expect(epochs).toEqual([...epochs].sort((a, b) => a - b))
  })
})

describe('buildTimeAxis – time scale (default)', () => {
  it('spaces points by asinh gap cost, not by array position', () => {
    const { rows } = buildTimeAxis([
      { date: '2024-01-01T12:00:00' },
      { date: '2024-01-11T12:00:00' },
      { date: '2024-02-10T12:00:00' },
    ])
    expect(rows[0].t).toBe(0)
    expect(rows[1].t).toBeCloseTo(Math.asinh(10), 6)
    expect(rows[2].t).toBeCloseTo(Math.asinh(10) + Math.asinh(30), 6)
  })

  it('keeps a multi-year gap from dominating while 2d vs 1mo stays distinct', () => {
    const { rows } = buildTimeAxis([
      { date: '2019-01-01T12:00:00' },
      { date: '2024-01-01T12:00:00' },
      { date: '2024-01-11T12:00:00' },
    ])
    const fiveYears = rows[1].t - rows[0].t
    const tenDays = rows[2].t - rows[1].t
    // Linear would be 1826/10 = 182.6×.
    expect(fiveYears / tenDays).toBeLessThan(3)
    expect(fiveYears / tenDays).toBeGreaterThan(2)
    // A month remains clearly longer than two days (asinh(30)/asinh(2) ≈ 2.8).
    expect(Math.asinh(30) / Math.asinh(2)).toBeGreaterThan(2)
  })

  it('emits one unique ascending tick per distinct reading timestamp', () => {
    const { ticks, tickDates } = buildTimeAxis([
      { date: '2024-01-01T12:00:00' },
      { date: '2024-01-11T12:00:00' },
      { date: '2024-01-11T12:00:00' },
    ])
    expect(ticks).toHaveLength(2)
    expect([...ticks]).toEqual([...ticks].sort((a, b) => a - b))
    expect(tickDates.get(ticks[0])?.date).toBe('2024-01-01T12:00:00')
    expect(tickDates.get(ticks[1])?.date).toBe('2024-01-11T12:00:00')
  })

  it('marks dense sub-regions for month-granularity labels', () => {
    const dense = Array.from({ length: 12 }, (_, i) => ({
      date: new Date(2024, 0, 1 + i, 12).toISOString(),
    }))
    const { ticks, tickDates } = buildTimeAxis(dense)
    expect(tickDates.get(ticks[0])?.monthOnly).toBe(true)

    const sparse = buildTimeAxis([
      { date: '2024-01-01T12:00:00' },
      { date: '2024-01-11T12:00:00' },
      { date: '2024-02-10T12:00:00' },
    ])
    expect(sparse.tickDates.get(sparse.ticks[0])?.monthOnly).toBe(false)
    expect(sparse.tickDates.get(sparse.ticks[1])?.monthOnly).toBe(false)
  })

  it('reports gaps longer than 60 days with rounded months', () => {
    const { longGaps } = buildTimeAxis([
      { date: '2022-01-01T12:00:00' },
      { date: '2024-01-01T12:00:00' },
      { date: '2024-01-11T12:00:00' },
    ])
    expect(longGaps).toHaveLength(1)
    expect(longGaps[0].months).toBe(24)
  })

  it('nudges identical timestamps apart without crossing mapped neighbours', () => {
    const { rows, ticks } = buildTimeAxis([
      { date: '2024-01-01T12:00:00' },
      { date: '2024-01-02T12:00:00' },
      { date: '2024-01-02T12:00:00' },
      { date: '2024-01-03T12:00:00' },
    ])
    const midX = ticks[1]
    expect(rows[0].t).toBeLessThan(rows[1].t)
    expect(rows[1].t).toBeLessThan(midX)
    expect(rows[2].t).toBeGreaterThan(midX)
    expect(rows[2].t).toBeLessThan(rows[3].t)
    // Bounded to under half the mapped gap to the previous distinct reading.
    expect(midX - rows[1].t).toBeLessThan((midX - rows[0].t) * 0.5)
  })

  it('leaves duplicates on one x when nudge is disabled', () => {
    const duplicate = { date: '2024-01-02T12:00:00' }
    const { rows } = buildTimeAxis([duplicate, { ...duplicate }], { nudge: false })
    expect(rows[0].t).toBe(rows[1].t)
  })

  it('handles an all-identical cluster without a zero-span domain', () => {
    const duplicate = { date: '2024-01-02T12:00:00' }
    const { rows, ticks, domain } = buildTimeAxis([duplicate, { ...duplicate }, { ...duplicate }])
    expect(ticks).toHaveLength(1)
    expect(domain[1]).toBeGreaterThan(domain[0])
    expect(rows.map((r) => r.t)).toEqual([...rows.map((r) => r.t)].sort((a, b) => a - b))
  })

  it('returns a safe axis for no rows', () => {
    expect(buildTimeAxis([])).toMatchObject({
      rows: [],
      ticks: [],
      domain: [0, 1],
      longGaps: [],
    })
  })
})

describe('buildTimeAxis – even mode', () => {
  it('gives every row one equal slot regardless of elapsed time', () => {
    const { rows, ticks } = buildTimeAxis(
      [
        { date: '2019-01-01T12:00:00' },
        { date: '2024-01-01T12:00:00' },
        { date: '2024-01-02T12:00:00' },
      ],
      { mode: 'even' },
    )
    expect(rows.map((r) => r.t)).toEqual([0, 1, 2])
    expect(ticks).toEqual([0, 1, 2])
  })

  it('separates identical timestamps into adjacent slots without nudging', () => {
    const duplicate = { date: '2024-01-02T12:00:00' }
    const { rows } = buildTimeAxis([duplicate, { ...duplicate }], { mode: 'even' })
    expect(rows.map((r) => r.t)).toEqual([0, 1])
  })

  it('still reports long gaps for the dashed annotator', () => {
    const { longGaps } = buildTimeAxis(
      [
        { date: '2022-01-01T12:00:00' },
        { date: '2024-01-01T12:00:00' },
      ],
      { mode: 'even' },
    )
    expect(longGaps).toHaveLength(1)
    expect(longGaps[0].months).toBe(24)
  })
})

describe('tickLabel', () => {
  it('adds a time sub-label for a non-midnight reading', () => {
    expect(tickLabel({ date: '2024-01-15T12:34:00', monthOnly: false }, 'en-US').sub).toBe(
      '12:34',
    )
  })

  it('drops to month granularity without a sub-label', () => {
    const { label, sub } = tickLabel({ date: '2024-01-15T12:34:00', monthOnly: true }, 'en-US')
    expect(label).toMatch(/Jan 2024/)
    expect(sub).toBeUndefined()
  })

  it('keeps an unparseable month-only date as-is', () => {
    expect(tickLabel({ date: 'not-a-date', monthOnly: true }, 'en-US')).toEqual({
      label: 'not-a-date',
    })
  })
})

describe('dateTickFormatter', () => {
  it('resolves mapped ticks and never formats an unresolved x as an epoch', () => {
    const resolve = (value: number | string) =>
      Number(value) === 5 ? { date: '2024-01-15T12:00:00', monthOnly: false } : undefined
    const format = dateTickFormatter('en-US', resolve)
    expect(format(5)).toBe('Jan 15, 2024')
    expect(format(6)).toBe('')
  })

  it('passes epoch/string values through when no resolver is given (legacy)', () => {
    const format = dateTickFormatter('en-US')
    expect(format(at(2024, 0, 15))).toBe(axisDateLabel(at(2024, 0, 15), 'en-US').label)
  })
})
