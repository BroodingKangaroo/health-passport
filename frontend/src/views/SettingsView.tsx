'use client'

import { useTranslations } from 'next-intl'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { useAuthStatus } from '@/components/providers/AuthStatusProvider'
import { ProfileCard } from '@/components/health-passport/settings/profile-card'
import { UsageCard } from '@/components/health-passport/settings/usage-card'
import { DataExportCard } from '@/components/health-passport/settings/data-export-card'
import { DangerZoneCard } from '@/components/health-passport/settings/danger-zone-card'

export function SettingsView() {
  const t = useTranslations('settings')
  const { status, user, anonId } = useAuthStatus()

  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />
      <main className="mx-auto w-full max-w-[1100px] p-5">
        <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <ProfileCard status={status} user={user} anonId={anonId} />
          <UsageCard />
          <DataExportCard />
          <DangerZoneCard user={user} />
        </div>
      </main>
    </div>
  )
}
