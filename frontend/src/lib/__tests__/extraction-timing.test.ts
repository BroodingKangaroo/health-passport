import { describe, it, expect } from 'vitest'
import { estimateExtractionTime, estimateMatchingTime } from '@/lib/extraction-timing'

// These are the FALLBACK estimates only — used when the backend's SSE
// progress events carry no `estimate_s` (Theil–Sen fit over its recent runs).
// Fitted to recent real stage timings: extraction ≈ 2s + 0.0023 s/char,
// matching ≈ flat ~3s with a tiny per-biomarker term.

describe('estimateExtractionTime', () => {
  it('floors at 2 seconds for tiny documents', () => {
    expect(estimateExtractionTime(0)).toBe(2)
  })

  it('scales at 0.0023s per character above the 2s intercept', () => {
    expect(estimateExtractionTime(1000)).toBeCloseTo(4.3)
    expect(estimateExtractionTime(3700)).toBeCloseTo(10.5, 1)
    expect(estimateExtractionTime(10_000)).toBeCloseTo(25)
  })
})

describe('estimateMatchingTime', () => {
  it('is nearly flat in the biomarker count', () => {
    expect(estimateMatchingTime(0)).toBe(5) // 3 floored
    expect(estimateMatchingTime(10)).toBe(5) // 3.4 floored
    expect(estimateMatchingTime(31)).toBe(5) // 4.24 floored
    expect(estimateMatchingTime(100)).toBe(7)
  })
})
