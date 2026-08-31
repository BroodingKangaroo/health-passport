import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LabResultForm } from '../health-passport/LabResultForm'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { FormCategory } from '@/lib/types'

vi.mock('@/lib/hooks/useBiomarkerDefinitions', () => ({
  useBiomarkerDefinitions: () => ({
    definitions: [
      {
        id: 'hbsag',
        names: { en: 'HBsAg', ru: 'HBsAg' },
        synonyms: [],
        unit: '',
        reference: { kind: 'qualitative', expected: 'Negative' },
        category: 'Microbiology',
        scope: 'global',
        reference_source: 'global',
      },
    ],
    loading: false,
    error: null,
  }),
}))

const qualitativeRow: FormCategory = {
  id: 'cat-1',
  name: 'Microbiology',
  rows: [
    {
      id: 'row-1',
      name: 'HBsAg',
      value: 'Not detected',
      unit: 'Qualitative',
      reference: { kind: 'qualitative', expected: 'Negative' },
      definition_id: 'hbsag',
      scope: 'global',
    },
  ],
}

const extractedNumericRow: FormCategory = {
  id: 'cat-2',
  name: 'Complete Blood Count',
  rows: [
    {
      id: 'row-2',
      name: 'Lymphocytes',
      value: '4850',
      unit: '/uL',
      reference: { kind: 'interval', low: 1320, high: 3570 },
      definition_id: 'lymph',
      scope: 'global',
    },
  ],
}

describe('LabResultForm (add-entry editor) RU rendering', () => {
  it('translates qualitative option labels while storing canonical values', () => {
    render(
      <TestI18nProvider locale="ru">
        <LabResultForm
          categories={[qualitativeRow]}
          addCategory={vi.fn()}
          updateCategoryName={vi.fn()}
          updateRow={vi.fn()}
          removeRow={vi.fn()}
          addRow={vi.fn()}
        />
      </TestI18nProvider>,
    )

    // Both selects (value + reference) carry the 8 canonical options with
    // Russian labels; the <option value> (what gets saved / compared) stays
    // the canonical enum.
    const notDetected = screen.getAllByText('Не обнаружено')
    expect(notDetected.length).toBe(2)
    for (const el of notDetected) {
      expect(el.closest('option')!.getAttribute('value')).toBe('Not detected')
    }
    const negative = screen.getAllByText('Отрицательно')
    expect(negative.length).toBe(2)
    for (const el of negative) {
      expect(el.closest('option')!.getAttribute('value')).toBe('Negative')
    }

    // The unit combobox displays the localized sentinel; the row keeps
    // the 'Qualitative' sentinel string itself.
    expect(screen.getByText('Качественный')).toBeTruthy()
    expect(screen.queryByText('Qualitative')).toBeNull()
  })

  it('keeps canonical English labels in the default (en) locale', () => {
    render(
      <TestI18nProvider locale="en">
        <LabResultForm
          categories={[qualitativeRow]}
          addCategory={vi.fn()}
          updateCategoryName={vi.fn()}
          updateRow={vi.fn()}
          removeRow={vi.fn()}
          addRow={vi.fn()}
        />
      </TestI18nProvider>,
    )

    expect(screen.getAllByText('Not detected').length).toBe(2)
    expect(screen.getAllByText('Negative').length).toBe(2)
    expect(screen.getByText('Qualitative')).toBeTruthy()
  })

  it('renders extracted English units readably in RU (/uL -> /мкл)', () => {
    render(
      <TestI18nProvider locale="ru">
        <LabResultForm
          categories={[extractedNumericRow]}
          addCategory={vi.fn()}
          updateCategoryName={vi.fn()}
          updateRow={vi.fn()}
          removeRow={vi.fn()}
          addRow={vi.fn()}
        />
      </TestI18nProvider>,
    )

    expect(screen.getByText('/мкл')).toBeTruthy()
    expect(screen.queryByText('/uL')).toBeNull()
  })

  it('keeps extracted units verbatim in the default (en) locale', () => {
    render(
      <TestI18nProvider locale="en">
        <LabResultForm
          categories={[extractedNumericRow]}
          addCategory={vi.fn()}
          updateCategoryName={vi.fn()}
          updateRow={vi.fn()}
          removeRow={vi.fn()}
          addRow={vi.fn()}
        />
      </TestI18nProvider>,
    )

    expect(screen.getByText('/uL')).toBeTruthy()
  })
})
