import { describe, it, expect } from 'vitest'
import { sortReadingsByDate } from '../utils'

describe('sortReadingsByDate', () => {
  it('sorts a mid-series "current" reading back into place (timeline regression)', () => {
    // biomarkersAtDate appends the selected event's reading AFTER the history,
    // so a non-latest selection arrives out of order (the screenshot bug).
    const readings = [
      { date: '2026-04-10T09:00:00', value: 18 },
      { date: '2026-04-24T17:01:00', value: 6 },
      { date: '2026-05-26T17:03:00', value: 8 },
      { date: '2026-05-16T16:57:00', value: 14 },
    ]
    expect(sortReadingsByDate(readings).map((r) => r.value)).toEqual([18, 6, 14, 8])
  })

  it('keeps same-timestamp readings in their original relative order (stable)', () => {
    const readings = [
      { date: '2026-05-16T09:00:00', value: 1 },
      { date: '2026-05-16T09:00:00', value: 2 },
      { date: '2026-05-15T09:00:00', value: 0 },
      { date: '2026-05-16T09:00:00', value: 3 },
    ]
    expect(sortReadingsByDate(readings).map((r) => r.value)).toEqual([0, 1, 2, 3])
  })

  it('places unparseable dates first without crashing', () => {
    const readings = [
      { date: '2026-05-16T09:00:00', value: 1 },
      { date: 'not-a-date', value: 2 },
    ]
    expect(sortReadingsByDate(readings).map((r) => r.value)).toEqual([2, 1])
  })

  it('does not mutate the input array', () => {
    const readings = [{ date: '2026-05-02', value: 1 }, { date: '2026-05-01', value: 2 }]
    const copy = [...readings]
    sortReadingsByDate(readings)
    expect(readings).toEqual(copy)
  })

  it('handles empty input', () => {
    expect(sortReadingsByDate([])).toEqual([])
  })

  it('returns a new array with the same object references', () => {
    const a = { date: '2026-05-02', value: 1 }
    const b = { date: '2026-05-01', value: 2 }
    const sorted = sortReadingsByDate([a, b])
    expect(sorted).not.toBe([b, a])
    expect(sorted).toEqual([b, a])
    expect(sorted[0]).toBe(b)
    expect(sorted[1]).toBe(a)
  })
})
