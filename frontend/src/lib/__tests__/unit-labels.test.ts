import { describe, it, expect } from 'vitest'
import { unitLabelRu } from '../unit-labels'
import { formatReference, unitLabel } from '../reference'

describe('unitLabelRu', () => {
  it('translates the dominant canonical units', () => {
    expect(unitLabelRu('mg/dL')).toBe('мг/дл')
    expect(unitLabelRu('mmol/L')).toBe('ммоль/л')
    expect(unitLabelRu('umol/L')).toBe('мкмоль/л')
    expect(unitLabelRu('g/dL')).toBe('г/дл')
    expect(unitLabelRu('copies/mL')).toBe('копий/мл')
    expect(unitLabelRu('10*3/uL')).toBe('×10³/мкл')
    expect(unitLabelRu('10*9/L')).toBe('×10⁹/л')
    expect(unitLabelRu('U/L')).toBe('Ед/л')
    expect(unitLabelRu('[IU]/mL')).toBe('МЕ/мл')
    expect(unitLabelRu('%')).toBe('%')
  })

  it('translates the backend-produced extraction forms', () => {
    // units_guess.py translates "кл/мкл" -> "/uL"; the add-entry editor
    // displays those rows verbatim, so the RU picker must render them.
    expect(unitLabelRu('/uL')).toBe('/мкл')
    expect(unitLabelRu('/µL')).toBe('/мкл')
    expect(unitLabelRu('K/µL')).toBe('тыс/мкл')
    expect(unitLabelRu('K/uL')).toBe('тыс/мкл')
  })

  it('matches case-insensitively and unifies µ/u', () => {
    expect(unitLabelRu('MG/DL')).toBe('мг/дл')
    expect(unitLabelRu('10*3/µL')).toBe('×10³/мкл')
    expect(unitLabelRu(' ng/ml ')).toBe('нг/мл')
  })

  it('passes unknown UCUM long-tail units through unchanged', () => {
    expect(unitLabelRu("[arb'U]/mL")).toBe("[arb'U]/mL")
    expect(unitLabelRu('{score}')).toBe('баллы')
    expect(unitLabelRu("[beth'U]")).toBe("[beth'U]")
    expect(unitLabelRu('dyn.s/cm5')).toBe('dyn.s/cm5')
  })

  it('handles empty input', () => {
    expect(unitLabelRu('')).toBe('')
    expect(unitLabelRu(null)).toBe('')
    expect(unitLabelRu(undefined)).toBe('')
  })
})

describe('formatReference lang integration', () => {
  it('translates the unit suffix for lang ru', () => {
    expect(formatReference({ kind: 'interval', low: 4, high: 11 }, 'mg/dL', { lang: 'ru' })).toBe(
      '4 – 11 мг/дл',
    )
    expect(formatReference({ kind: 'interval', low: null, high: 0.7 }, 'copies/mL', { lang: 'ru' })).toBe(
      '≤ 0.7 копий/мл',
    )
  })

  it('keeps the unit verbatim for other languages / no lang', () => {
    expect(formatReference({ kind: 'interval', low: 4, high: 11 }, 'mg/dL')).toBe('4 – 11 mg/dL')
    expect(formatReference({ kind: 'interval', low: 4, high: 11 }, 'mg/dL', { lang: 'de' })).toBe(
      '4 – 11 mg/dL',
    )
  })

  it('translates a qualitative expected text for lang ru and never appends a unit', () => {
    expect(formatReference({ kind: 'qualitative', expected: 'Not detected' }, 'copies/mL', { lang: 'ru' })).toBe(
      'Не обнаружено',
    )
    expect(formatReference({ kind: 'qualitative', expected: 'Negative' }, null, { lang: 'ru' })).toBe(
      'Отрицательно',
    )
  })

  it('passes non-canonical expected text through in any language', () => {
    expect(formatReference({ kind: 'qualitative', expected: 'отсутствуют' }, null, { lang: 'ru' })).toBe(
      'отсутствуют',
    )
  })
})

describe('unitLabel lang integration', () => {
  it('localizes the Qualitative word and translates units for ru', () => {
    expect(unitLabel('', { kind: 'qualitative', expected: 'Negative' }, 'ru')).toBe('Качественный')
    expect(unitLabel('', { kind: 'qualitative', expected: 'Negative' })).toBe('Qualitative')
    expect(unitLabel('mg/dL', null, 'ru')).toBe('мг/дл')
    expect(unitLabel('mg/dL', null)).toBe('mg/dL')
  })
})
