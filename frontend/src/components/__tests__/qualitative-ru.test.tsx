import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { ResultsPanel } from '../health-passport/results-panel'
import { PrintEditor } from '@/components/health-passport/print-editor'
import { PrintConfigProvider } from '@/providers/print-config-provider'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type {
  BiomarkerResult,
  DateHeader,
  MatrixCategory,
  PrintLang,
  Reference,
} from '@/lib/types'

afterEach(() => {
  sessionStorage.clear()
})

function qualitativeBiomarker(
  id: string,
  en: string,
  value: string,
  expected: string,
): BiomarkerResult {
  return {
    id,
    entry_id: 'evt-1',
    definition: {
      id,
      names: { en, ru: `${en} (ru)` },
      synonyms: [],
      category: 'Microbiology',
      unit: '',
      reference: { kind: 'qualitative', expected },
      scope: 'global',
      reference_source: 'global',
    },
    value,
    date: 'Jan 15, 2027',
    status: 'normal',
  }
}

const numericBiomarker: BiomarkerResult = {
  id: 'hb',
  entry_id: 'evt-1',
  definition: {
    id: 'hb',
    names: { en: 'Hemoglobin', ru: 'Гемоглобин' },
    synonyms: [],
    category: 'Complete Blood Count',
    unit: 'g/dL',
    reference: { kind: 'interval', low: 130, high: 170 },
    scope: 'global',
    reference_source: 'global',
  },
  value: 150,
  date: 'Jan 15, 2027',
  status: 'normal',
}

describe('RU locale renders translated qualitative values and units', () => {
  it('results panel: value, unit column and reference column are Russian', () => {
    const biomarkers = [
      qualitativeBiomarker('hbsag', 'HBsAg', 'Negative', 'Not detected'),
      numericBiomarker,
    ]
    render(
      <TestI18nProvider locale="ru">
        <ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />
      </TestI18nProvider>,
    )

    expect(screen.getByText('Отрицательно')).toBeTruthy()
    expect(screen.getByText('Не обнаружено')).toBeTruthy()
    expect(screen.getByText('Качественный')).toBeTruthy()
    expect(screen.getByText('г/дл')).toBeTruthy()
    // The English enum never leaks into the RU render.
    expect(screen.queryByText('Negative')).toBeNull()
    expect(screen.queryByText('Not detected')).toBeNull()
    expect(screen.queryByText('Qualitative')).toBeNull()
  })

  it('results panel: English locale keeps canonical strings (passthrough)', () => {
    const biomarkers = [qualitativeBiomarker('hbsag', 'HBsAg', 'Negative', 'Not detected')]
    render(
      <TestI18nProvider locale="en">
        <ResultsPanel biomarkers={biomarkers} labName="Lab" date="Jan 15, 2027" />
      </TestI18nProvider>,
    )

    expect(screen.getByText('Negative')).toBeTruthy()
    expect(screen.getByText('Not detected')).toBeTruthy()
    expect(screen.getByText('Qualitative')).toBeTruthy()
    expect(screen.queryByText('Отрицательно')).toBeNull()
  })
})

// ---- Print editor (document language, not UI locale) ----

const ruDates: DateHeader[] = [{ label: '10.08.2024' }]

const ruMatrix: MatrixCategory[] = [
  {
    category: 'Microbiology',
    rows: [
      {
        id: 'hbv',
        name: 'HBV DNA',
        original: 'ДНК ВГВ',
        unit: 'copies/mL',
        reference: { kind: 'interval', low: 0, high: 100 } as Reference,
        cells: [{ value: 'Not detected', status: 'normal' }],
      },
      {
        id: 'hbsag',
        name: 'HBsAg',
        original: 'HBsAg',
        unit: '',
        reference: { kind: 'qualitative', expected: 'Negative' } as Reference,
        cells: [{ value: 'Negative', status: 'normal' }],
      },
    ],
  },
]

function PrintEditorInit(props: {
  dates: DateHeader[]
  matrix: MatrixCategory[]
  lang: PrintLang
}) {
  const { initFilters } = usePrintConfig()
  useEffect(() => {
    initFilters(
      props.dates.map((d) => d.label),
      props.matrix.flatMap((c) => c.rows.map((r) => r.id)),
    )
  }, [props.dates, props.matrix, initFilters])
  return <PrintEditor {...props} bilingual={false} onBack={vi.fn()} biomarkers={[]} />
}

function renderEditor(lang: PrintLang) {
  return render(
    <TestI18nProvider>
      <PrintConfigProvider>
        <PrintEditorInit dates={ruDates} matrix={ruMatrix} lang={lang} />
      </PrintConfigProvider>
    </TestI18nProvider>,
  )
}

describe('RU print document translates qualitative cells and unit suffixes', () => {
  it('lang ru: cells and the reference line are Russian', () => {
    renderEditor('ru')
    expect(screen.getByText('Не обнаружено')).toBeTruthy()
    // 'Negative' renders twice: once as the HBsAg cell, once as its
    // qualitative reference line under the name.
    expect(screen.getAllByText('Отрицательно').length).toBe(2)
    expect(screen.getByText('0 – 100 копий/мл')).toBeTruthy()
    expect(screen.queryByText(/copies\/mL/)).toBeNull()
  })

  it('lang en: canonical strings pass through unchanged', () => {
    renderEditor('en')
    expect(screen.getByText('Not detected')).toBeTruthy()
    expect(screen.getAllByText('Negative').length).toBe(2)
    expect(screen.getByText('0 – 100 copies/mL')).toBeTruthy()
  })
})
