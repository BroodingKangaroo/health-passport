'use client'

import { ViewerProvider } from '@/providers/viewer-provider'
import { DemoTimelineView } from '@/components/landing/demo-view'

export default function DemoPage() {
  return (
    <ViewerProvider capability="demo">
      <DemoTimelineView />
    </ViewerProvider>
  )
}
