'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useRouter } from 'next/navigation'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { NavBar } from '@/components/shared/NavBar'
import { ShareNotice } from '@/components/share/sender/share-notice'
import { TimelineContent } from '@/views/timeline-content'
import { useTimelineData } from '@/hooks/useTimelineData'

// `TimelineContent` and `biomarkersAtDate` live in `views/timeline-content.tsx`
// (the shared recipient tree renders the same body). Re-exported here because
// this is the module the app's callers and tests import them from.
export { TimelineContent, biomarkersAtDate } from '@/views/timeline-content'

export function TimelineView() {
  const router = useRouter()
  const { data, isLoading, error, refetch } = useTimelineData()
  const chromeRef = useRef<HTMLDivElement>(null)
  const [chromeH, setChromeH] = useState(0)

  // The mobile switcher (§5.7) pins below the sticky chrome; its height
  // changes when the header wraps (RU labels, zoom), so measure it instead of
  // hardcoding an offset. /demo does not use this wrapper and inherits the
  // `--chrome-h: 0px` default from globals.css.
  useLayoutEffect(() => {
    const el = chromeRef.current
    if (!el) return
    const measure = () => setChromeH(el.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      style={{ '--chrome-h': `${chromeH}px` } as CSSProperties}
      className="flex min-h-screen flex-col bg-background lg:h-screen lg:min-h-0 lg:overflow-hidden print:block print:h-auto print:min-h-0 print:overflow-visible"
    >
      <div ref={chromeRef} className="sticky top-0 z-40 lg:static print:static">
        <HeaderBar />
        <NavBar activeTab="timeline" />
      </div>
      {/* Quiet, self-hiding aside between the chrome and the two-pane shell:
          it only exists while an active link can see newer results. /demo
          renders TimelineContent directly, so the marketing surface never
          asks about links. */}
      <ShareNotice />
      <TimelineContent
        data={data}
        isLoading={isLoading}
        error={error}
        refetch={refetch}
        onViewDetails={(id) => router.push('/details?id=' + id + '&from=timeline')}
      />
    </div>
  )
}
