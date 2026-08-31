import { describe, it, expect } from 'vitest'
import { qualitativeLabel, qualitativeUnitLabel, QUALITATIVE_LABELS } from '../qualitative-labels'
import { QUALITATIVE_VALUES } from '../reference'

describe('qualitativeLabel', () => {
  it('translates every canonical enum value to Russian', () => {
    const ru = QUALITATIVE_LABELS.ru
    for (const v of QUALITATIVE_VALUES) {
      expect(ru[v], `missing RU label for ${v}`).toBeTruthy()
      expect(qualitativeLabel(v, 'ru')).toBe(ru[v])
    }
  })

  it('is identity for the default (en) locale', () => {
    expect(qualitativeLabel('Negative')).toBe('Negative')
    expect(qualitativeLabel('Not detected', 'en')).toBe('Not detected')
  })

  it('passes unknown / raw document text through unchanged in any language', () => {
    expect(qualitativeLabel('не выявлено', 'ru')).toBe('не выявлено')
    expect(qualitativeLabel('Borrelia negative', 'ru')).toBe('Borrelia negative')
    expect(qualitativeLabel('отсутствуют', 'en')).toBe('отсутствуют')
  })

  it('is case-sensitive on canonical values (unknown casing passes through)', () => {
    expect(qualitativeLabel('negative', 'ru')).toBe('negative')
  })

  it('handles numbers and nullish input', () => {
    expect(qualitativeLabel(5, 'ru')).toBe('5')
    expect(qualitativeLabel(null, 'ru')).toBe('')
    expect(qualitativeLabel(undefined, 'ru')).toBe('')
  })

  it('covers the same 8-value set as the backend enum', () => {
    expect(Object.keys(QUALITATIVE_LABELS.ru).sort()).toEqual([...QUALITATIVE_VALUES].sort())
  })
})

describe('qualitativeUnitLabel', () => {
  it('localizes the "Qualitative" unit-column word', () => {
    expect(qualitativeUnitLabel('en')).toBe('Qualitative')
    expect(qualitativeUnitLabel('ru')).toBe('Качественный')
  })

  it('falls back to English for other print languages', () => {
    expect(qualitativeUnitLabel('de')).toBe('Qualitative')
    expect(qualitativeUnitLabel('he')).toBe('Qualitative')
  })
})
