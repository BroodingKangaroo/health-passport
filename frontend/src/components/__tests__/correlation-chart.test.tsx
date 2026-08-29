import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  CorrelationChart,
  normalizedValue,
} from '../health-passport/correlation-chart'
import type { BiomarkerResult, Reference } from '@/lib/types'
import { TestI18nProvider } from '@/test/i18n-test-provider'

const renderI18n = ((ui: React.ReactElement, options?: Parameters<typeof render>[1]) =>
  render(<TestI18nProvider>{ui}</TestI18nProvider>, options)) as typeof render

vi.mock('recharts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: React.ReactElement<{ width?: number; height?: number }>
    }) => React.cloneElement(children, { width: 800, height: 450 }),
  }
})

function makeBiomarker(
  id: string,
  name: string,
  opts: {
    value?: number | string | null
    dates?: { date: string; value: number }[]
    reference?: Reference | null
  } = {},
): BiomarkerResult {
  const reference =
    opts.reference !== undefined
      ? opts.reference
      : ({ kind: 'interval', low: 4, high: 11 } as Reference)
  const history =
    opts.dates?.map((d, i) => ({
      entry_id: `${id}-h${i}`,
      date: d.date,
      value: d.value,
      status: 'normal' as const,
    })) ?? []
  return {
    id,
    entry_id: `${id}-latest`,
    definition: {
      id,
      names: { en: name },
      synonyms: [],
      unit: '',
      reference,
      category: 'chemistry',
      scope: 'local',
      reference_source: 'local',
    },
    value: opts.value ?? null,
    date: opts.dates?.at(-1)?.date ?? '2026-07-01',
    status: 'normal',
    history,
    reference,
  }
}

describe('normalizedValue', () => {
  it('normalizes within an interval reference to 0-100', () => {
    const ref: Reference = { kind: 'interval', low: 4, high: 11 }
    expect(normalizedValue(4, ref)).toBeCloseTo(0)
    expect(normalizedValue(7.5, ref)).toBeCloseTo(50)
    expect(normalizedValue(11, ref)).toBeCloseTo(100)
  })

  it('normalizes one-sided upper references as percent of the bound', () => {
    const ref: Reference = { kind: 'interval', low: null, high: 0.7 }
    expect(normalizedValue(0.7, ref)).toBeCloseTo(100)
    expect(normalizedValue(1.4, ref)).toBeCloseTo(200)
  })

  it('normalizes one-sided lower references as percent of the bound', () => {
    const ref: Reference = { kind: 'interval', low: 4, high: null }
    expect(normalizedValue(4, ref)).toBeCloseTo(100)
    expect(normalizedValue(2, ref)).toBeCloseTo(50)
  })

  it('treats exact-value references as percent of the expected value', () => {
    const ref: Reference = { kind: 'interval', low: 5, high: 5 }
    expect(normalizedValue(5, ref)).toBeCloseTo(100)
    expect(normalizedValue(10, ref)).toBeCloseTo(200)
  })

  it('maps qualitative presence to 100 and absence to 0', () => {
    const ref: Reference = { kind: 'qualitative', expected: 'Negative' }
    expect(normalizedValue(0, ref)).toBeCloseTo(0)
    expect(normalizedValue(1, ref)).toBeCloseTo(100)
  })
})

describe('CorrelationChart', () => {
  function showSelectTab() {
    fireEvent.click(screen.getByRole('button', { name: 'Select biomarkers' }))
  }

  it('shows single-measurement biomarkers in the picker (onboarding case)', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('b1', 'Hemoglobin', { value: 7 }),
          makeBiomarker('b2', 'WBC', { value: 5 }),
        ]}
      />,
    )
    showSelectTab()
    expect(screen.getByLabelText('Hemoglobin')).toBeInTheDocument()
    expect(screen.getByLabelText('WBC')).toBeInTheDocument()
    expect(
      screen.queryByText('Select at least one biomarker to display the correlation chart.'),
    ).not.toBeInTheDocument()
  })

  it('plots single-measurement biomarkers instead of showing the empty prompt', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('b1', 'Hemoglobin', { value: 7 }),
          makeBiomarker('b2', 'WBC', { value: 5 }),
        ]}
      />,
    )
    expect(
      screen.queryByText('No numeric readings to chart for the selected biomarkers.'),
    ).not.toBeInTheDocument()
  })

  it('notes that correlation needs at least 2 paired readings', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('b1', 'Hemoglobin', { value: 7 }),
          makeBiomarker('b2', 'WBC', { value: 5 }),
        ]}
      />,
    )
    expect(
      screen.getByText(
        'Need at least 2 paired readings on shared dates to compute correlation.',
      ),
    ).toBeInTheDocument()
  })

  it('computes and shows the correlation for multi-date series', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('b1', 'Hemoglobin', {
            dates: [
              { date: '2026-01-01', value: 5 },
              { date: '2026-02-01', value: 6 },
              { date: '2026-03-01', value: 7 },
            ],
            value: 7,
          }),
          makeBiomarker('b2', 'WBC', {
            dates: [
              { date: '2026-01-01', value: 4 },
              { date: '2026-02-01', value: 7 },
              { date: '2026-03-01', value: 10 },
            ],
            value: 10,
          }),
        ]}
      />,
    )
    expect(screen.getByText(/Pairwise correlation/)).toBeInTheDocument()
    expect(screen.getAllByText(/r = 1\.00/).length).toBeGreaterThan(0)
  })

  it('auto-selects the most correlated pair on load', () => {
    // C is listed first so the naive "first two" fallback would pick C+A;
    // the suggestion logic must instead select A+B (r = 1.0 vs 0.5).
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('c1', 'Creatinine', {
            dates: [
              { date: '2026-01-01', value: 5 },
              { date: '2026-02-01', value: 7 },
              { date: '2026-03-01', value: 6 },
              { date: '2026-04-01', value: 6 },
              { date: '2026-05-01', value: 7 },
            ],
            value: 6,
          }),
          makeBiomarker('a1', 'Hemoglobin', {
            dates: [
              { date: '2026-01-01', value: 5 },
              { date: '2026-02-01', value: 6 },
              { date: '2026-03-01', value: 7 },
              { date: '2026-04-01', value: 8 },
              { date: '2026-05-01', value: 9 },
            ],
            value: 7,
          }),
          makeBiomarker('b1', 'WBC', {
            dates: [
              { date: '2026-01-01', value: 4 },
              { date: '2026-02-01', value: 7 },
              { date: '2026-03-01', value: 10 },
              { date: '2026-04-01', value: 13 },
              { date: '2026-05-01', value: 16 },
            ],
            value: 10,
          }),
        ]}
      />,
    )
    expect(screen.getByText(/Top correlated pairs/)).toBeInTheDocument()
    showSelectTab()
    const hemo = screen.getByLabelText('Hemoglobin') as HTMLInputElement
    const wbc = screen.getByLabelText('WBC') as HTMLInputElement
    const creat = screen.getByLabelText('Creatinine') as HTMLInputElement
    expect(hemo.checked).toBe(true)
    expect(wbc.checked).toBe(true)
    expect(creat.checked).toBe(false)
  })

  it('re-applies a suggested pair via its chip', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('c1', 'Creatinine', {
            dates: [
              { date: '2026-01-01', value: 5 },
              { date: '2026-02-01', value: 7 },
              { date: '2026-03-01', value: 6 },
              { date: '2026-04-01', value: 6 },
              { date: '2026-05-01', value: 7 },
            ],
            value: 6,
          }),
          makeBiomarker('a1', 'Hemoglobin', {
            dates: [
              { date: '2026-01-01', value: 5 },
              { date: '2026-02-01', value: 6 },
              { date: '2026-03-01', value: 7 },
              { date: '2026-04-01', value: 8 },
              { date: '2026-05-01', value: 9 },
            ],
            value: 7,
          }),
          makeBiomarker('b1', 'WBC', {
            dates: [
              { date: '2026-01-01', value: 4 },
              { date: '2026-02-01', value: 7 },
              { date: '2026-03-01', value: 10 },
              { date: '2026-04-01', value: 13 },
              { date: '2026-05-01', value: 16 },
            ],
            value: 10,
          }),
        ]}
      />,
    )
    showSelectTab()
    fireEvent.click(screen.getByLabelText('Hemoglobin'))
    expect(
      (screen.getByLabelText('Hemoglobin') as HTMLInputElement).checked,
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Top correlated pairs' }))
    fireEvent.click(screen.getByRole('button', { name: /Hemoglobin\s*×\s*WBC/ }))
    showSelectTab()
    expect(
      (screen.getByLabelText('Hemoglobin') as HTMLInputElement).checked,
    ).toBe(true)
    expect((screen.getByLabelText('WBC') as HTMLInputElement).checked).toBe(true)
  })

  it('highlights the pair that is currently selected', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('c1', 'Creatinine', {
            dates: [
              { date: '2026-01-01', value: 5 },
              { date: '2026-02-01', value: 7 },
              { date: '2026-03-01', value: 6 },
              { date: '2026-04-01', value: 6 },
              { date: '2026-05-01', value: 7 },
            ],
            value: 6,
          }),
          makeBiomarker('a1', 'Hemoglobin', {
            dates: [
              { date: '2026-01-01', value: 5 },
              { date: '2026-02-01', value: 6 },
              { date: '2026-03-01', value: 7 },
              { date: '2026-04-01', value: 8 },
              { date: '2026-05-01', value: 9 },
            ],
            value: 7,
          }),
          makeBiomarker('b1', 'WBC', {
            dates: [
              { date: '2026-01-01', value: 4 },
              { date: '2026-02-01', value: 7 },
              { date: '2026-03-01', value: 10 },
              { date: '2026-04-01', value: 13 },
              { date: '2026-05-01', value: 16 },
            ],
            value: 10,
          }),
        ]}
      />,
    )
    const selectedRow = screen.getByRole('button', {
      name: /Hemoglobin\s*×\s*WBC/,
    })
    expect(selectedRow.className).toContain('bg-primary/10')
    const otherRow = screen.getByRole('button', {
      name: /Hemoglobin\s*×\s*Creatinine/,
    })
    expect(otherRow.className).not.toContain('bg-primary/10')
  })

  it('does not suggest pairs without enough shared readings', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('a1', 'Hemoglobin', {
            dates: [{ date: '2026-01-01', value: 5 }],
            value: 6,
          }),
          makeBiomarker('b1', 'WBC', {
            dates: [{ date: '2026-01-01', value: 4 }],
            value: 5,
          }),
        ]}
      />,
    )
    expect(screen.queryByRole('button', { name: /×/ })).not.toBeInTheDocument()
  })

  it('surfaces more than three suggested pairs when many qualify', () => {
    const mk = (id: string, name: string) =>
      makeBiomarker(id, name, {
        dates: [
          { date: '2026-01-01', value: 5 },
          { date: '2026-02-01', value: 6 },
          { date: '2026-03-01', value: 7 },
          { date: '2026-04-01', value: 8 },
          { date: '2026-05-01', value: 9 },
        ],
        value: 7,
      })
    renderI18n(
      <CorrelationChart
        biomarkers={[
          mk('a1', 'Hemoglobin'),
          mk('b1', 'WBC'),
          mk('c1', 'Creatinine'),
          mk('d1', 'Glucose'),
        ]}
      />,
    )
    // 4 perfectly correlated biomarkers -> C(4,2) = 6 qualifying pairs.
    expect(screen.getAllByRole('button', { name: /×/ })).toHaveLength(6)
  })

  it('labels strength and confidence in plain language', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('a1', 'Hemoglobin', {
            dates: [
              { date: '2026-01-01', value: 5 },
              { date: '2026-02-01', value: 6 },
              { date: '2026-03-01', value: 7 },
            ],
            value: 7,
          }),
          makeBiomarker('b1', 'WBC', {
            dates: [
              { date: '2026-01-01', value: 4 },
              { date: '2026-02-01', value: 7 },
              { date: '2026-03-01', value: 10 },
            ],
            value: 10,
          }),
        ]}
      />,
    )
    expect(screen.getAllByText('Strong positive').length).toBeGreaterThan(0)
    expect(
      screen.getAllByText(/3 readings · likely a real relationship/).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText(/p not estimable/)).not.toBeInTheDocument()
    expect(screen.queryByText(/p <|p =/)).not.toBeInTheDocument()
  })

  it('explains too-few-readings in plain language', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('a1', 'Hemoglobin', {
            dates: [
              { date: '2026-01-01', value: 5 },
              { date: '2026-02-01', value: 6 },
            ],
            value: 7,
          }),
          makeBiomarker('b1', 'WBC', {
            dates: [
              { date: '2026-01-01', value: 4 },
              { date: '2026-02-01', value: 7 },
            ],
            value: 10,
          }),
        ]}
      />,
    )
    // Two shared dates -> n = 2, no p-value, plain-language note instead.
    expect(
      screen.getByText(/2 readings · too few readings to tell/),
    ).toBeInTheDocument()
  })

  it('shows a dedicated empty state when there is no biomarker data', () => {
    renderI18n(<CorrelationChart biomarkers={[]} />)
    expect(
      screen.getByText('No biomarker data yet — add a blood test to get started.'),
    ).toBeInTheDocument()
  })

  it('excludes biomarkers with no readings at all from the picker', () => {
    const empty = makeBiomarker('b3', 'Empty', { value: null })
    renderI18n(
      <CorrelationChart
        biomarkers={[
          makeBiomarker('b1', 'Hemoglobin', { value: 7 }),
          empty,
        ]}
      />,
    )
    showSelectTab()
    expect(screen.queryByLabelText('Empty')).not.toBeInTheDocument()
  })

  it('shows the select prompt again when the user unchecks everything', () => {
    renderI18n(
      <CorrelationChart
        biomarkers={[makeBiomarker('b1', 'Hemoglobin', { value: 7 })]}
      />,
    )
    showSelectTab()
    fireEvent.click(screen.getByLabelText('Hemoglobin'))
    expect(
      screen.getByText('Select at least one biomarker to display the correlation chart.'),
    ).toBeInTheDocument()
  })
})
