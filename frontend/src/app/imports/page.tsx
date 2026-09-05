'use client'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { ImportsTracker } from '@/components/health-passport/imports-tracker'

export default function ImportsPage() {
  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />
      <main className="p-5">
        <ImportsTracker />
      </main>
    </div>
  )
}
