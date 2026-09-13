import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import BiomarkerChartInner from '@/components/shared/BiomarkerChartInner'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { BiomarkerDefinition, BiomarkerResult, Reading } from '@/lib/types'

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

const definition: BiomarkerDefinition = {
  id: 'esr',
  names: { en: 'ESR', ru: 'СОЭ' },
  synonyms: [],
  unit: 'mm/h',
  reference: { kind: 'interval', low: 0, high: 15 },
  category: '',
  scope: 'global',
  reference_source: 'global',
}

// 10 days, then 30 days — equal spacing would render these identically.
const readings: Reading[] = [
  { entry_id: 'e1', date: '2024-01-01T12:00:00', value: 18, status: 'high' },
  { entry_id: 'e2', date: '2024-01-11T12:00:00', value: 6, status: 'normal' },
  { entry_id: 'e3', date: '2024-02-10T12:00:00', value: 8, status: 'normal' },
]

// Two years of silence, then a 10-day follow-up.
const longGapReadings: Reading[] = [
  { entry_id: 'g1', date: '2022-01-01T12:00:00', value: 18, status: 'high' },
  { entry_id: 'g2', date: '2024-01-01T12:00:00', value: 6, status: 'normal' },
  { entry_id: 'g3', date: '2024-01-11T12:00:00', value: 8, status: 'normal' },
]

const biomarker: BiomarkerResult = {
  id: 'esr',
  entry_id: 'e3',
  definition,
  value: 8,
  date: '2024-02-10T12:00:00',
  status: 'normal',
  history: readings.slice(0, 2),
}

function renderChart(payload: Reading[] = readings) {
  return render(
    <TestI18nProvider>
      <BiomarkerChartInner biomarker={biomarker} data={payload} />
    </TestI18nProvider>,
  )
}

function renderedTicks(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.recharts-cartesian-axis-tick-label'))
    .map((label) => {
      const transform = label.querySelector('g[transform]')?.getAttribute('transform') ?? ''
      const x = Number(/translate\(([-\d.]+)/.exec(transform)?.[1] ?? Number.NaN)
      return { text: label.querySelector('text')?.textContent ?? '', x }
    })
    .filter((tick) => Number.isFinite(tick.x))
    .sort((a, b) => a.x - b.x)
}

describe('BiomarkerChartInner x axis', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('labels every reading date on the default time scale', () => {
    const { container } = renderChart()
    expect(renderedTicks(container).map((tick) => tick.text)).toEqual([
      'Jan 1, 2024',
      'Jan 11, 2024',
      'Feb 10, 2024',
    ])
  })

  it('spaces readings by warped gap cost on the time scale', () => {
    const { container } = renderChart()
    const ticks = renderedTicks(container)
    const firstGap = ticks[1].x - ticks[0].x
    const secondGap = ticks[2].x - ticks[1].x
    // asinh(30) / asinh(10) ≈ 1.366 — clearly time-ordered, not 1:1.
    expect(secondGap / firstGap).toBeCloseTo(1.37, 1)
  })

  it('switches to equal slots when Even spacing is chosen', () => {
    const { container } = renderChart()
    const evenButton = screen.getByRole('button', { name: 'Even spacing' })
    expect(evenButton).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(evenButton)
    expect(evenButton).toHaveAttribute('aria-pressed', 'true')
    expect(window.localStorage.getItem('hp.chartAxisMode')).toBe('even')

    const ticks = renderedTicks(container)
    const firstGap = ticks[1].x - ticks[0].x
    const secondGap = ticks[2].x - ticks[1].x
    expect(secondGap / firstGap).toBeCloseTo(1, 2)
  })

  it('remembers the axis choice across mounts', () => {
    const first = renderChart()
    fireEvent.click(screen.getByRole('button', { name: 'Even spacing' }))
    first.unmount()

    renderChart()
    expect(screen.getByRole('button', { name: 'Even spacing' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('dashes and annotates long gaps on the time scale', () => {
    const { container } = renderChart(longGapReadings)
    expect(container.querySelector('path[stroke-dasharray="4 4"]')).not.toBeNull()
    expect(screen.getByText('≈ 24 mo')).toBeInTheDocument()
    expect(
      screen.getByText('Long gaps are compressed — order stays chronological'),
    ).toBeInTheDocument()
  })

  it('hides the scale note in even spacing', () => {
    renderChart(longGapReadings)
    fireEvent.click(screen.getByRole('button', { name: 'Even spacing' }))
    expect(
      screen.queryByText('Long gaps are compressed — order stays chronological'),
    ).toBeNull()
  })
})
