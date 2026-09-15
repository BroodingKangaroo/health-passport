import { describe, expect, it } from 'vitest'

import { STATUS_TEXT_CLASS, isOutOfRange } from '../status-labels'

/**
 * The backend persists ``status = ""`` for a numeric value against an
 * unrecognized qualitative expected value (docs/architecture.md "Reference
 * model"). It means UNKNOWN, not abnormal — every flag/star/red-bold/sort
 * decision must treat it as neutral.
 */
describe('isOutOfRange', () => {
  it('flags only low/high/abnormal', () => {
    expect(isOutOfRange('low')).toBe(true)
    expect(isOutOfRange('high')).toBe(true)
    expect(isOutOfRange('abnormal')).toBe(true)
  })

  it('never flags normal, unknown ("") or missing statuses', () => {
    expect(isOutOfRange('normal')).toBe(false)
    expect(isOutOfRange('')).toBe(false)
    expect(isOutOfRange(null)).toBe(false)
    expect(isOutOfRange(undefined)).toBe(false)
  })

  it('gives the unknown status a neutral text class (never a status color)', () => {
    expect(STATUS_TEXT_CLASS['']).toBe('text-muted-foreground')
    expect(STATUS_TEXT_CLASS['']).not.toMatch(/status-(low|high)/)
  })
})
