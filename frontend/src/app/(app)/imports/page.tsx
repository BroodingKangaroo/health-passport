'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { ImportsTracker } from '@/components/health-passport/imports-tracker'
import { BackNav } from '@/components/shared/BackNav'

export default function ImportsPage() {
  const router = useRouter()
  const tBack = useTranslations('misc.backLinks')
  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />
      <BackNav label={tBack('dashboard')} onBack={() => router.push('/')} />
      <main className="p-5">
        <ImportsTracker />
      </main>
    </div>
  )
}
