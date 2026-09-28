'use client'

import { useTranslations } from 'next-intl'

import { FlowsheetMatrix } from '@/components/health-passport/flowsheet-matrix'
import { Button } from '@/components/ui/button'
import type { SharedFlowsheetState } from '@/components/share/use-shared-flowsheet'

/**
 * The full longitudinal table ("All results" in the summary, the matrix in the
 * full record).
 *
 * Presentational on purpose: the payload is fetched once by the shell
 * (`useSharedFlowsheet`, called from `SharedRecordView`) and handed down, so
 * switching views does not re-request it. One component in both views, so the
 * table cannot drift between them.
 */
export function SharedFlowsheet({
  state,
  sectionId = 'shared-results',
}: {
  state: SharedFlowsheetState
  sectionId?: string
}) {
  const t = useTranslations('sharedView')
  const { flowsheet, status, retry } = state

  return (
    <section aria-labelledby={sectionId}>
      <h2 id={sectionId} className="mb-3 text-base font-semibold text-foreground">
        {t('results.title')}
      </h2>
      {status === 'loading' && (
        <p className="text-sm text-muted-foreground">{t('results.loading')}</p>
      )}
      {status === 'error' && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">{t('results.error')}</p>
          <Button variant="outline" size="sm" onClick={retry}>
            {t('results.retry')}
          </Button>
        </div>
      )}
      {status === 'ready' && flowsheet && flowsheet.matrix.length > 0 && (
        <FlowsheetMatrix
          dates={flowsheet.dates}
          matrix={flowsheet.matrix}
          biomarkers={flowsheet.biomarkers}
          // No sparkline column for a recipient: those charts are the only
          // reason recharts (~350 KB) would load on this page, and a stranger
          // opens it on a phone. The numbers, ranges and reading history are
          // all still here; the shared surface simply has no charts (ST2).
          showTrend={false}
        />
      )}
    </section>
  )
}
