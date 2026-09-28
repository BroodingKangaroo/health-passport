import { describe, expect, it } from 'vitest'

import { formatDay } from '../utils'

describe('formatDay', () => {
  // Reading dates are wall-clock text from the source document: the backend
  // stores them WITHOUT an offset. Parsed as a local instant and rendered in
  // UTC, a midnight sample slides to the previous day for a reader east of
  // UTC ("Sep 16, 2026 at 21:00" for a 17 September result) — the exact bug
  // this anchors against.
  it('keeps a bare midnight reading on its own calendar day', () => {
    expect(formatDay('2026-09-17T00:00:00', 'en-US')).toBe('Sep 17, 2026')
  })

  it('keeps a bare reading time intact', () => {
    expect(formatDay('2026-03-20T17:00:00', 'en-US')).toBe(
      'Mar 20, 2026 at 17:00',
    )
  })

  it('renders an offset-carrying instant in UTC', () => {
    expect(formatDay('2026-01-12T00:00:00+00:00', 'en-US')).toBe('Jan 12, 2026')
  })

  it('falls back to the raw string when it is not a date', () => {
    expect(formatDay('not a date', 'en-US')).toBe('not a date')
  })
})
