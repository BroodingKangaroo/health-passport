'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { ChartLine } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { BiomarkerResult } from '@/lib/types'

/**
 * The correlation section of the FULL record, and nothing else.
 *
 * Two decisions are load-bearing (shared-view plan §6):
 *
 * - **Not in the summary.** The summary is the clinical read — what is out of
 *   range, and what moved. Correlation surfaces pairs at n ≥ 4 and |r| ≥ 0.5,
 *   which on a clinician's screen reads as an assertion; that belongs behind
 *   the recipient's own choice, not on the first screen.
 * - **The chart arrives on a CLICK.** The app's correlation component needs
 *   recharts (~350 KB), and no shared page fetches it at first paint — ST2 got
 *   the page to 797 KB by keeping every chart off it. A `next/dynamic`
 *   component is still imported when it MOUNTS, so the dynamic component is
 *   rendered only after the reader asks for the chart; nothing fetches
 *   recharts on load, in either view.
 *
 * The numbers are the OWNER'S numbers rather than a second implementation:
 * this renders the same `CorrelationChart` over the same `biomarkers` array,
 * which the record payload already narrowed to this link's date range and
 * entry-type exclusions. That is why there is no `/api/share/correlation`
 * endpoint. The owner's correlation is computed in the browser from the
 * timeline payload (`lib/stats.ts`), so a server-side twin would be a second
 * source of truth for the same numbers — exactly the drift the acceptance
 * criterion ("the same numbers as the owner's view") rules out.
 */
const LazyCorrelationChart = dynamic(
  () =>
    import('@/components/health-passport/correlation-chart').then(
      (mod) => mod.CorrelationChart,
    ),
  { ssr: false, loading: () => <ChartLoading /> },
)

function ChartLoading() {
  const t = useTranslations('sharedView.correlation')
  return <p className="text-sm text-muted-foreground">{t('loading')}</p>
}

/**
 * The app's own rule for "this biomarker can be charted"
 * (`correlation-chart.tsx` → `hasReadings`), restated here on purpose:
 * importing it would pull that module — and therefore recharts — into the
 * shared tree's EAGER graph, which is the one thing this section exists to
 * avoid. The two must agree; the section test pins the boundary.
 */
export function hasReadings(biomarker: BiomarkerResult): boolean {
  return (biomarker.history?.length ?? 0) > 0 || biomarker.value != null
}

export function SharedCorrelation({
  biomarkers,
}: {
  biomarkers: BiomarkerResult[]
}) {
  const t = useTranslations('sharedView.correlation')
  const [shown, setShown] = useState(false)
  const chartable = biomarkers.filter(hasReadings)

  return (
    <section
      id="shared-correlation"
      aria-labelledby="shared-correlation-heading"
      data-testid="shared-correlation"
    >
      <h2
        id="shared-correlation-heading"
        className="mb-3 text-base font-semibold text-foreground"
      >
        {t('title')}
      </h2>
      <p className="mb-3 max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>

      {chartable.length < 2 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : shown ? (
        <LazyCorrelationChart biomarkers={biomarkers} />
      ) : (
        <Button variant="outline" onClick={() => setShown(true)}>
          <ChartLine className="size-4" aria-hidden />
          {t('show')}
        </Button>
      )}

      <p className="mt-3 max-w-3xl text-xs text-muted-foreground">{t('caveat')}</p>
    </section>
  )
}
