import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SharedCorrelation } from '@/components/share/SharedCorrelation'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { BiomarkerDefinition, BiomarkerResult } from '@/lib/types'

/**
 * Counts how many times the correlation CHART module is reached.
 *
 * The whole point of the section is that this number is zero until the reader
 * asks for the chart: `next/dynamic` still imports its target when it mounts,
 * so a component that renders the dynamic chart unconditionally would fetch
 * recharts (~350 KB) in the full record's first paint. This is the boundary
 * the bundle measurement in the report confirms on a real build.
 */
const { chartModuleLoaded } = vi.hoisted(() => ({ chartModuleLoaded: vi.fn() }))

vi.mock('@/components/health-passport/correlation-chart', () => {
  chartModuleLoaded()
  return {
    // The real component's prop contract, minus recharts — the mock is about
    // WHEN the module is reached, and what it is handed.
    CorrelationChart: ({ biomarkers }: { biomarkers: BiomarkerResult[] }) => (
      <div data-testid="correlation-chart" data-count={biomarkers.length} />
    ),
  }
})

const definition = (id: string, name: string): BiomarkerDefinition => ({
  id,
  names: { en: name, ru: name },
  synonyms: [],
  unit: 'g/dL',
  reference: { kind: 'interval', low: 1, high: 10 },
  category: 'Blood',
  scope: 'global',
  reference_source: 'global',
})

/** A biomarker with a reading — chartable, by the app's own rule. */
const withReadings = (id: string, name: string, value: number): BiomarkerResult => ({
  id,
  entry_id: 'blood-1',
  definition: definition(id, name),
  value,
  date: '2026-01-12T00:00:00+00:00',
  status: 'normal',
  history: [],
})

/** A biomarker with no reading at all — `hasReadings` is false for it. */
const withoutReadings = (id: string, name: string): BiomarkerResult => ({
  id,
  entry_id: 'blood-1',
  definition: definition(id, name),
  value: null,
  date: '2026-01-12T00:00:00+00:00',
  status: '',
  history: [],
})

const renderSection = (biomarkers: BiomarkerResult[], locale = 'en') =>
  render(
    <TestI18nProvider locale={locale}>
      <SharedCorrelation biomarkers={biomarkers} />
    </TestI18nProvider>,
  )

beforeEach(() => {
  chartModuleLoaded.mockClear()
})

describe('SharedCorrelation', () => {
  it('reaches the chart module only after the reader asks for the chart', async () => {
    renderSection([withReadings('hb', 'Hemoglobin', 10), withReadings('wbc', 'WBC', 6)])

    // Nothing before the click: no module, no chart, not even a placeholder.
    expect(chartModuleLoaded).not.toHaveBeenCalled()
    expect(screen.queryByTestId('correlation-chart')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show correlation chart/i }))

    await waitFor(() => expect(chartModuleLoaded).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('correlation-chart')).toBeInTheDocument()
  })

  it('hands the chart the record’s own biomarkers, unmodified', async () => {
    const biomarkers = [
      withReadings('hb', 'Hemoglobin', 10),
      withReadings('wbc', 'WBC', 6),
      // Not chartable, and still passed through: the chart applies the same
      // `hasReadings` filter the owner's view does, so filtering here would be
      // a second, silently different rule.
      withoutReadings('mucus', 'Mucus (urine)'),
    ]
    renderSection(biomarkers)
    fireEvent.click(screen.getByRole('button', { name: /show correlation chart/i }))

    expect((await screen.findByTestId('correlation-chart')).dataset.count).toBe('3')
  })

  it('says so, and offers no button, when fewer than two biomarkers can be charted', () => {
    renderSection([withReadings('hb', 'Hemoglobin', 10), withoutReadings('mucus', 'Mucus')])

    expect(
      screen.getByText(/needs readings from at least two different ones/i),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show correlation chart/i })).toBeNull()
    expect(chartModuleLoaded).not.toHaveBeenCalled()
  })

  it('carries the exploratory framing and the recipient caveat', () => {
    renderSection([withReadings('hb', 'Hemoglobin', 10), withReadings('wbc', 'WBC', 6)])

    expect(screen.getByRole('heading', { name: 'Correlation' })).toBeInTheDocument()
    // The plan's claim risk (§6): the framing must say "exploratory, not a
    // diagnosis, no causation" next to the chart, not only in the footer.
    expect(screen.getByText(/not a diagnosis/i)).toBeInTheDocument()
    expect(screen.getByText(/does not show that one measurement causes another/i)).toBeInTheDocument()
    expect(screen.getByText(/statistical observation about this record alone/i)).toBeInTheDocument()
  })

  it('renders its framing in Russian under the recipient’s locale', () => {
    renderSection([withReadings('hb', 'Hemoglobin', 10), withReadings('wbc', 'WBC', 6)], 'ru')
    expect(screen.getByRole('heading', { name: 'Корреляции' })).toBeInTheDocument()
    expect(screen.getByText(/не диагноз/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /показать график корреляций/i }),
    ).toBeInTheDocument()
  })
})
