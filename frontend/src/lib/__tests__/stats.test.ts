import { describe, it, expect } from 'vitest'
import { pearson, correlationPValue, pairwiseCorrelations } from '../stats'

describe('pearson', () => {
  it('returns 1 for a perfect positive linear relationship', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10)
  })

  it('returns -1 for a perfect negative linear relationship', () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10)
  })

  it('returns null for fewer than 2 points', () => {
    expect(pearson([1], [2])).toBeNull()
    expect(pearson([], [])).toBeNull()
  })

  it('returns null when a series has zero variance', () => {
    expect(pearson([1, 1, 1], [2, 4, 6])).toBeNull()
  })

  it('computes a known r (0.7746) for a classic example', () => {
    const r = pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])
    expect(r).toBeCloseTo(0.7746, 3)
  })

  it('clamps a perfect correlation to exactly 1', () => {
    const r = pearson([10, 20, 30], [11, 22, 33])
    expect(r).toBe(1)
    expect(correlationPValue(r as number, 3)).toBe(0)
  })

  it('clamps a perfect negative correlation to exactly -1', () => {
    expect(pearson([10, 20, 30], [-11, -22, -33])).toBe(-1)
  })
})

describe('correlationPValue', () => {
  it('returns 1 for r = 0', () => {
    expect(correlationPValue(0, 10)).toBeCloseTo(1, 6)
  })

  it('returns 0 for a perfect correlation', () => {
    expect(correlationPValue(1, 10)).toBeCloseTo(0, 6)
  })

  it('returns a small p for a strong correlation (r=0.8, n=10)', () => {
    // t = 3.771 on 8 df → two-sided p ≈ 0.0055 (verified against the
    // incomplete beta integral and standard t-tables).
    expect(correlationPValue(0.8, 10)).toBeCloseTo(0.0055, 3)
  })

  it('returns NaN for n < 3', () => {
    expect(Number.isNaN(correlationPValue(0.5, 2))).toBe(true)
  })
})

describe('pairwiseCorrelations', () => {
  it('aligns series by index and skips missing points', () => {
    const series = {
      a: [10, null, 30, 40],
      b: [1, 2, 3, 4],
    }
    const stats = pairwiseCorrelations(series)
    const pair = stats['a|b']
    expect(pair).toBeDefined()
    expect(pair!.n).toBe(3)
    expect(pair!.r).toBeCloseTo(pearson([10, 30, 40], [1, 3, 4])!, 10)
  })

  it('omits pairs with fewer than 2 co-present points', () => {
    const stats = pairwiseCorrelations({ a: [10, null, null], b: [1, 2, 3] })
    expect(stats['a|b']).toBeUndefined()
  })

  it('omits pairs with a degenerate (zero-variance) series', () => {
    const stats = pairwiseCorrelations({ a: [10, 10, 10], b: [1, 2, 3] })
    expect(stats['a|b']).toBeUndefined()
  })
})
