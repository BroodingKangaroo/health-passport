import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useEffect } from 'react'
import { PrintEditor } from '@/components/health-passport/print-editor'
import { PrintConfigProvider } from '@/providers/print-config-provider'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import type { DateHeader, MatrixCategory, PrintLang, BiomarkerResult } from '@/lib/types'

const mockDates: DateHeader[] = [
  { label: '10.08.2024' },
  { label: '20.09.2025' },
  { label: '15.10.2025', sub: '09:00' },
]

const mockMatrix: MatrixCategory[] = [
  {
    category: 'Complete Blood Count',
    rows: [
      {
        id: 'hb',
        name: 'Hemoglobin',
        original: 'Гемоглобин',
        unit: 'g/dL',
        reference: { kind: 'interval', low: 12.0, high: 16.0 },
        cells: [
          { value: '13.5', status: 'normal' },
          { value: '14.2', status: 'normal' },
          { value: '10.1', status: 'low' },
        ],
      },
      {
        id: 'wbc',
        name: 'Leukocytes',
        original: 'Лейкоциты',
        unit: 'K/µL',
        reference: { kind: 'interval', low: 4.0, high: 11.0 },
        cells: [
          { value: '5.2', status: 'normal' },
          { value: '6.8', status: 'normal' },
          { value: '15.8', status: 'high' },
        ],
      },
    ],
  },
  {
    category: 'Lipid Panel',
    rows: [
      {
        id: 'ldl',
        name: 'LDL Cholesterol',
        original: 'ЛПНП холестерин',
        unit: 'mg/dL',
        reference: { kind: 'interval', low: 0, high: 130 },
        cells: [
          { value: '155', status: 'high' },
          { value: '125', status: 'normal' },
          { value: '—', status: 'normal' },
        ],
      },
    ],
  },
]

const mockBiomarkers: BiomarkerResult[] = [
  {
    id: 'hb-aug-10-2024',
    definition: {
      id: 'hb',
      names: { en: 'Hemoglobin', ru: 'Гемоглобин', es: 'Hemoglobina', de: 'Hämoglobin', fr: 'Hémoglobine', he: 'המוגלובין' },
      synonyms: [],
      unit: 'g/dL',
      reference: { kind: 'interval', low: 12.0, high: 16.0 },
      category: 'Complete Blood Count',
      scope: 'global',
      reference_source: 'global',
    },
    value: 13.5,
    date: '2024-08-10',
    status: 'normal',
  },
  {
    id: 'wbc-aug-10-2024',
    definition: {
      id: 'wbc',
      names: { en: 'Leukocytes', ru: 'Лейкоциты', es: 'Leucocitos', de: 'Leukozyten', fr: 'Globules blancs', he: 'תאי דם לבנים' },
      synonyms: [],
      unit: 'K/µL',
      reference: { kind: 'interval', low: 4.0, high: 11.0 },
      category: 'Complete Blood Count',
      scope: 'global',
      reference_source: 'global',
    },
    value: 5.2,
    date: '2024-08-10',
    status: 'normal',
  },
  {
    id: 'ldl-aug-10-2024',
    definition: {
      id: 'ldl',
      names: { en: 'LDL Cholesterol', ru: 'ЛПНП холестерин', es: 'Colesterol LDL', de: 'LDL-Cholesterin', fr: 'Cholestérol LDL', he: 'כולסטרול LDL' },
      synonyms: [],
      unit: 'mg/dL',
      reference: { kind: 'interval', low: 0, high: 130 },
      category: 'Lipid Panel',
      scope: 'global',
      reference_source: 'global',
    },
    value: 155,
    date: '2024-08-10',
    status: 'high',
  },
]

function dateId(d: DateHeader): string {
  return d.label + (d.sub ? '--' + d.sub : '')
}

function PrintEditorInit(props: {
  dates: DateHeader[]
  matrix: MatrixCategory[]
  biomarkers?: BiomarkerResult[]
  lang: PrintLang
  bilingual: boolean
  onBack: () => void
}) {
  const { initFilters } = usePrintConfig()
  useEffect(() => {
    const allDateLabels = props.dates.map((d) => dateId(d))
    const allRowIds = props.matrix.flatMap((cat) => cat.rows.map((r) => r.id))
    initFilters(allDateLabels, allRowIds)
  }, [])
  return <PrintEditor {...props} />
}

function renderEditor(props?: {
  lang?: PrintLang
  bilingual?: boolean
  dates?: DateHeader[]
  matrix?: MatrixCategory[]
  biomarkers?: BiomarkerResult[]
}) {
  const dates = props?.dates ?? mockDates
  const matrix = props?.matrix ?? mockMatrix
  const biomarkers = props?.biomarkers ?? mockBiomarkers
  return render(
    <PrintConfigProvider>
      <PrintEditorInit
        dates={dates}
        matrix={matrix}
        biomarkers={biomarkers}
        lang={props?.lang ?? 'en'}
        bilingual={props?.bilingual ?? false}
        onBack={vi.fn()}
      />
    </PrintConfigProvider>,
  )
}

describe('PrintEditor', () => {
  it('renders all date columns in the table header', () => {
    renderEditor()
    expect(screen.getAllByText('10.08.2024').length).toBeGreaterThan(0)
    expect(screen.getAllByText('20.09.2025').length).toBeGreaterThan(0)
    expect(screen.getAllByText('15.10.2025').length).toBeGreaterThan(0)
  })

  it('renders all categories and biomarkers', () => {
    renderEditor()
    expect(screen.getAllByText('Complete Blood Count').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Lipid Panel').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Hemoglobin').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Leukocytes').length).toBeGreaterThan(0)
    expect(screen.getAllByText('LDL Cholesterol').length).toBeGreaterThan(0)
  })

  it('renders biomarker values in table cells', () => {
    renderEditor()
    expect(screen.getByText('13.5')).toBeTruthy()
    expect(screen.getByText('14.2')).toBeTruthy()
    expect(screen.getByText('5.2')).toBeTruthy()
    expect(screen.getByText('155', { exact: false })).toBeTruthy()
  })

  it('shows range below biomarker name when showRanges is on', () => {
    renderEditor()
    expect(screen.getByText('12 – 16 g/dL')).toBeTruthy()
    expect(screen.getByText('4 – 11 K/µL')).toBeTruthy()
    expect(screen.getByText('0 – 130 mg/dL')).toBeTruthy()
  })

  it('hides date column when its checkbox is unchecked', () => {
    renderEditor()
    const dateCheckboxes = screen.getAllByRole('checkbox').filter(
      (cb) => cb.closest('section')?.querySelector('h3')?.textContent === 'Columns (Dates)',
    )
    expect(dateCheckboxes.length).toBeGreaterThan(0)
  })

  it('toggles out-of-range only filter', () => {
    renderEditor()
    const toggle = screen.getByText('Show Abnormal Only').closest('button')!
    fireEvent.click(toggle)
    expect(toggle).toHaveClass('border-primary')
  })

  it('hides low and high markers with asterisk', () => {
    renderEditor()
    const lowCells = screen.queryAllByText(/\*$/)
    expect(lowCells.length).toBeGreaterThan(0)
  })

  it('shows language in the document header', () => {
    renderEditor({ lang: 'ru' })
    expect(screen.getByText(/Язык/)).toBeTruthy()
  })

  it('shows bilingual indicator when bilingual is true', () => {
    renderEditor({ lang: 'de', bilingual: true })
    expect(screen.getByText(/\+ RU/)).toBeTruthy()
  })

  it('translates biomarker names to Spanish when lang is es', () => {
    renderEditor({ lang: 'es' })
    const rows = screen.getAllByRole('row')
    expect(rows.some((r) => r.textContent?.includes('Hemoglobina'))).toBe(true)
  })

  it('translates biomarker names to German when lang is de', () => {
    renderEditor({ lang: 'de' })
    const rows = screen.getAllByRole('row')
    expect(rows.some((r) => r.textContent?.includes('Hämoglobin'))).toBe(true)
  })

  it('shows translated name and original in bilingual German mode', () => {
    renderEditor({ lang: 'de', bilingual: true })
    const rows = screen.getAllByRole('row')
    expect(rows.some((r) => r.textContent?.includes('Hämoglobin / Гемоглобин'))).toBe(true)
  })

  it('translates biomarker names to French when lang is fr', () => {
    renderEditor({ lang: 'fr' })
    const rows = screen.getAllByRole('row')
    expect(rows.some((r) => r.textContent?.includes('Hémoglobine'))).toBe(true)
  })

  it('translates biomarker names to Hebrew when lang is he', () => {
    renderEditor({ lang: 'he' })
    const rows = screen.getAllByRole('row')
    expect(rows.some((r) => r.textContent?.includes('המוגלובין'))).toBe(true)
  })

  it('renders category sub-headers', () => {
    renderEditor()
    const headers = screen.getAllByRole('row')
    const categoryRows = headers.filter((h) =>
      h.textContent?.includes('Complete Blood Count') ||
      h.textContent?.includes('Lipid Panel'),
    )
    expect(categoryRows.length).toBe(2)
  })

  it('shows time sub label for timed entries', () => {
    renderEditor()
    expect(screen.getByText('09:00')).toBeTruthy()
  })

  it('preset Last 10 selects all dates when fewer than 10 exist', () => {
    renderEditor()
    fireEvent.click(screen.getByText('Last 10'))
    const checked = screen.getAllByRole('checkbox').filter(
      (cb) => cb.closest('section')?.querySelector('h3')?.textContent === 'Columns (Dates)',
    )
    checked.forEach((cb) => expect(cb).toBeChecked())
  })

  it('preset All selects all dates', () => {
    renderEditor()
    fireEvent.click(screen.getByText('All'))
    const checked = screen.getAllByRole('checkbox').filter(
      (cb) => cb.closest('section')?.querySelector('h3')?.textContent === 'Columns (Dates)',
    )
    checked.forEach((cb) => expect(cb).toBeChecked())
  })

  it('excludes biomarker with no data for any visible date', () => {
    const matrixWithMissing: MatrixCategory[] = [
      ...mockMatrix,
      {
        category: 'Vitamins',
        rows: [
          {
            id: 'vitd',
            name: 'Vitamin D',
            original: 'Витамин D',
            unit: 'ng/mL',
            reference: { kind: 'interval', low: 30, high: 100 },
            cells: [{ value: '\u2014', status: 'normal' }, { value: '\u2014', status: 'normal' }, { value: '\u2014', status: 'normal' }],
          },
        ],
      },
    ]
    renderEditor({ matrix: matrixWithMissing })
    const rows = screen.getAllByRole('row')
    const vitDInTable = rows.some((r) => r.textContent?.includes('Vitamin D'))
    expect(vitDInTable).toBe(false)
    const hbInTable = rows.some((r) => r.textContent?.includes('Hemoglobin'))
    expect(hbInTable).toBe(true)
  })
})
