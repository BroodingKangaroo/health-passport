'use client'

import { DemoModeProvider } from '@/providers/demo-provider'
import { DemoTimelineView } from '@/components/landing/demo-view'

export default function DemoPage() {
  return (
    <DemoModeProvider>
      <DemoTimelineView />
    </DemoModeProvider>
  )
}
