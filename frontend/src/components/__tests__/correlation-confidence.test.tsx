import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { CorrelationChart } from '@/components/health-passport/correlation-chart'
import { ViewerProvider } from '@/providers/viewer-provider'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { BiomarkerDefinition, BiomarkerResult, Reading } from '@/lib/types'

/**
 * The one part of the correlation chart that changes for a recipient.
 *
 * The owner's view says "likely a real relationship" and explains the 5%
 * threshold underneath. A shared link must not: the page ranks the top pairs
 * by |r|, so that threshold is never corrected for the selection, and on a
 * clinician's screen it reads as an assertion (shared-view plan §6, ST3
 * review). The recipient gets the sample size and the exploratory framing.
 *
 * recharts supplies only layout here — the stand-ins keep this test about the
 * copy, and let it render in jsdom at all.
 */
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    ResponsiveContainer: Pass,
    LineChart: Pass,
    Line: () => null,
    XAxis: () => null,
    YAxis: () => null,
    ReferenceArea: () => null,
    Tooltip: () => null,
    Curve: () => null,
  }
})

const definition = (id: string, name: string): BiomarkerDefinition => ({
  id,
  names: { en: name, ru: name },
  synonyms: [],
  unit: 'g/dL',
  category: 'Blood',
  scope: 'global',
  reference: { kind: 'interval', low: 0, high: 10 },
  reference_source: 'global',
})

const reading = (entryId: string, date: string, value: number): Reading => ({
  entry_id: entryId,
  date,
  value,
  status: 'normal',
})

const DAYS = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01']

/** Five aligned readings that move together perfectly: n = 5, r = 1. */
const biomarker = (id: string, name: string, scale: number): BiomarkerResult => ({
  id,
  entry_id: `blood-${id}-5`,
  definition: definition(id, name),
  value: 5 * scale,
  date: `${DAYS[4]}T00:00:00+00:00`,
  status: 'normal',
  history: [1, 2, 3, 4].map((n, i) =>
    reading(`blood-${id}-${i + 1}`, `${DAYS[i]}T00:00:00+00:00`, n * scale),
  ),
})

const biomarkers = [biomarker('hb', 'Hemoglobin', 1), biomarker('mchc', 'MCHC', 2)]

function renderChart(capability: 'owner' | 'shared') {
  return render(
    <TestI18nProvider>
      <ViewerProvider capability={capability}>
        <CorrelationChart biomarkers={biomarkers} />
      </ViewerProvider>
    </TestI18nProvider>,
  )
}

describe('correlation confidence copy', () => {
  it('keeps the owner’s significance verdict', () => {
    const { container } = renderChart('owner')
    expect(container.textContent).toContain('likely a real relationship')
    expect(container.textContent).toContain('5% chance this link is coincidence')
  })

  it('gives a recipient the sample size and the exploratory framing instead', () => {
    const { container } = renderChart('shared')
    expect(container.textContent).toContain('exploratory: 5 shared readings')
    expect(container.textContent).not.toContain('likely a real relationship')
    // The legend sentence exists only to explain that phrase, so it goes too.
    expect(container.textContent).not.toContain('5% chance this link is coincidence')
    // The rest of the legend is not a claim and stays.
    expect(container.textContent).toContain('how closely two biomarkers move together')
  })

  it('names the sample size exactly once in the recipient’s pair line', () => {
    renderChart('shared')
    const line = screen.getByText(/exploratory: 5 shared readings/).textContent ?? ''
    expect(line.match(/5 shared readings/g)?.length).toBe(1)
  })

  it('carries the same framing in the pair row’s own label', () => {
    renderChart('shared')
    // The row's title is the full sentence, and it is the only place the
    // strength, the sample size and the framing appear together.
    const row = screen.getByTitle(/Hemoglobin × MCHC/)
    expect(row).toHaveAttribute(
      'title',
      'Hemoglobin × MCHC — Strong positive, exploratory: 5 shared readings',
    )
    // …and it never states the verdict, in the label or the visible text.
    expect(row.getAttribute('title')).not.toContain('likely a real relationship')
    expect(row.textContent).not.toContain('likely a real relationship')
  })
})
