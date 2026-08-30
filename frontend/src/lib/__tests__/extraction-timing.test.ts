import { describe, it, expect } from 'vitest'
import { estimateExtractionTime, estimateMatchingTime } from '@/lib/extraction-timing'

// These are the FALLBACK estimates only — used when the backend's SSE
// progress events carry no `estimate_s` (median of its recent runs).
// Fitted to recent real stage timings: extraction ≈ 2s + 0.003/char,
// matching ≈ flat ~3s with a tiny per-biomarker term.

describe('estimateExtractionTime', () => {
  it('floors at 4 seconds for small documents', () => {
    expect(estimateExtractionTime(0)).toBe(4)
    expect(estimateExtractionTime(500)).toBe(4)
  })

  it('scales at 0.003s per character above the floor', () => {
    expect(estimateExtractionTime(1000)).toBeCloseTo(5)
    expect(estimateExtractionTime(10_000)).toBeCloseTo(32)
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
