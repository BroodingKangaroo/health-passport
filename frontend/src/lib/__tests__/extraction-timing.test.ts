import { describe, it, expect } from 'vitest'
import { estimateExtractionTime, estimateMatchingTime } from '@/lib/extraction-timing'

describe('estimateExtractionTime', () => {
  it('floors at 5 seconds for small documents', () => {
    expect(estimateExtractionTime(0)).toBe(5)
    expect(estimateExtractionTime(500)).toBe(5)
  })

  it('scales at 0.006s per character above the floor', () => {
    expect(estimateExtractionTime(1000)).toBeCloseTo(6)
    expect(estimateExtractionTime(10_000)).toBeCloseTo(60)
  })
})

describe('estimateMatchingTime', () => {
  it('uses the biomarker count formula once any count is known', () => {
    expect(estimateMatchingTime(1, 0)).toBe(12) // 9.2 floored
    expect(estimateMatchingTime(10, 0)).toBe(20) // 10 * 1.2 + 8
    expect(estimateMatchingTime(100, 999_999)).toBe(128) // ignores chars
  })

  it('falls back to character-based estimate when no biomarkers are known', () => {
    expect(estimateMatchingTime(0, 100)).toBe(15) // 2.5 floored
    expect(estimateMatchingTime(0, 1000)).toBe(25)
  })
})
