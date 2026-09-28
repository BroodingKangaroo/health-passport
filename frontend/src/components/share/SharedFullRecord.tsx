'use client'

import { useTranslations } from 'next-intl'

import { SharedFlowsheet } from '@/components/share/SharedFlowsheet'
import { SharedCorrelation } from '@/components/share/SharedCorrelation'
import type { SharedFlowsheetState } from '@/components/share/use-shared-flowsheet'
import { TimelineContent } from '@/views/timeline-content'
import type { SharedRecord } from '@/lib/share'

/**
 * The full record: the app's own timeline and flowsheet over someone else's
 * data, read-only (shared-view plan §2).
 *
 * It renders `TimelineContent` — the same props-driven body the owner's
 * timeline and the /demo page render — so the two surfaces cannot drift. What
 * is NOT here is deliberate and structural: no `onViewDetails` (the detail is
 * already inline; the app's `/details` route is authed), no upload, no add
 * entry, no notifications, no entry settings, no documents tab. The viewer
 * capability carries the rest (`components` ask `useViewer()`, not a demo
 * flag), and the backend being GET-only is the real guarantee.
 *
 * The record arrives as a prop; this component performs no fetch. The
 * flowsheet is fetched lazily, exactly as it is in the summary, and the
 * correlation chart is not fetched at all until the reader asks for it (ST3).
 */
export function SharedFullRecord({
  record,
  flowsheetState,
}: {
  record: SharedRecord
  flowsheetState: SharedFlowsheetState
}) {
  const t = useTranslations('sharedView')
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {/* The shell's <h1> is the record's identity; this one names the view
          for a screen reader without repeating the name visually. */}
      <h1 className="sr-only">{t('viewSwitch.full')}</h1>
      {/* `landmark="div"`: the timeline's body would otherwise emit a second
          <main> inside this one. */}
      <TimelineContent
        data={record}
        isLoading={false}
        error={null}
        refetch={() => {}}
        landmark="div"
      />
      {/* Between the timeline and the table, like the app's own tab order
          would put it — but above the matrix rather than under it, because a
          9,000px table is not a place to hide the only interactive view of
          the full record. The chart itself does not load until the reader
          asks for it (see SharedCorrelation). */}
      <div className="mx-auto w-full max-w-[1800px] px-5 pb-6">
        <SharedCorrelation biomarkers={record.biomarkers} />
      </div>
      <div className="mx-auto w-full max-w-[1800px] px-5 pb-6">
        <SharedFlowsheet state={flowsheetState} sectionId="shared-full-flowsheet" />
      </div>
    </main>
  )
}
