import { describe, expect, it } from 'vitest'

import { formatNumber } from '@/lib/utils'
import { formatReference } from '@/lib/reference'

describe('formatNumber', () => {
  it('returns "" for null / undefined / empty', () => {
    expect(formatNumber(null)).toBe('')
    expect(formatNumber(undefined)).toBe('')
    expect(formatNumber('')).toBe('')
  })

  it('keeps small values (< 1000) as-is', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(8.75)).toBe('8.75')
    expect(formatNumber(123)).toBe('123')
    expect(formatNumber(-42)).toBe('-42')
  })

  it('formats thousands as K', () => {
    expect(formatNumber(1234)).toBe('1.23K')
    expect(formatNumber(10_000)).toBe('10K')
    expect(formatNumber(999_999)).toBe('1000K')
  })

  it('formats millions as M', () => {
    expect(formatNumber(1_234_567)).toBe('1.23M')
    expect(formatNumber(90_000_000)).toBe('90M')
    expect(formatNumber(800_000_000)).toBe('800M')
  })

  it('formats billions as B', () => {
    expect(formatNumber(1_000_000_000)).toBe('1B')
    expect(formatNumber(10_000_000_000)).toBe('10B')
    expect(formatNumber(100_000_000_000)).toBe('100B')
  })

  it('formats trillions as T', () => {
    expect(formatNumber(1_000_000_000_000)).toBe('1T')
    expect(formatNumber(2.5e15)).toBe('2500T')
  })

  it('passes through non-numeric strings unchanged', () => {
    expect(formatNumber('Not detected')).toBe('Not detected')
    expect(formatNumber('Negative')).toBe('Negative')
    expect(formatNumber('—')).toBe('—')
  })

  it('parses numeric strings and formats them', () => {
    expect(formatNumber('10000000000')).toBe('10B')
    expect(formatNumber('8.75')).toBe('8.75')
    expect(formatNumber('1.5e10')).toBe('15B')
  })

  it('drops trailing zeros', () => {
    expect(formatNumber(1_500_000_000)).toBe('1.5B')
    expect(formatNumber(1_000_000_000)).toBe('1B')
    expect(formatNumber(2_000)).toBe('2K')
  })
})

describe('formatReference (compact number formatting)', () => {
  it('keeps small interval bounds as-is', () => {
    expect(
      formatReference({ kind: 'interval', low: 4, high: 11 }),
    ).toBe('4 – 11')
  })

  it('formats large interval bounds with K/M/B/T suffixes', () => {
    expect(
      formatReference({
        kind: 'interval',
        low: 1_000_000_000,
        high: 10_000_000_000,
      }),
    ).toBe('1B – 10B')
    expect(
      formatReference({
        kind: 'interval',
        low: 1_000_000,
        high: 100_000_000,
      }),
    ).toBe('1M – 100M')
  })

  it('formats one-sided bounds with K/M/B/T suffixes', () => {
    expect(
      formatReference({ kind: 'interval', low: null, high: 1e11 }),
    ).toBe('≤ 100B')
    expect(
      formatReference({ kind: 'interval', low: 8, high: null }),
    ).toBe('≥ 8')
  })

  it('handles unbounded interval', () => {
    expect(
      formatReference({ kind: 'interval', low: null, high: null }),
    ).toBe('—')
  })

  it('formats qualitative refs as-is', () => {
    expect(
      formatReference({ kind: 'qualitative', expected: 'Not detected' }),
    ).toBe('Not detected')
    expect(
      formatReference({ kind: 'qualitative', expected: null }),
    ).toBe('—')
  })

  it('appends unit suffix', () => {
    expect(
      formatReference(
        { kind: 'interval', low: 1e9, high: 1e10 },
        'ГЭ/г',
      ),
    ).toBe('1B – 10B ГЭ/г')
  })

  it('returns em-dash for null ref', () => {
    expect(formatReference(null)).toBe('—')
  })
})
