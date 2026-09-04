'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { Button } from '@/components/ui/button'
import { useAuthStatus } from '@/components/providers/AuthStatusProvider'
import { useLeaveGuard } from '@/providers/leave-guard-provider'
import { ProfileCard } from '@/components/health-passport/settings/profile-card'
import { UsageCard } from '@/components/health-passport/settings/usage-card'
import { DataExportCard } from '@/components/health-passport/settings/data-export-card'
import { DangerZoneCard } from '@/components/health-passport/settings/danger-zone-card'

export function SettingsView() {
  const t = useTranslations('settings')
  const back = useTranslations('misc.backLinks')
  const router = useRouter()
  const { confirmLeave } = useLeaveGuard()
  const { status, user, anonId } = useAuthStatus()

  async function handleBack() {
    // Consistent with every other view exit: a running AI process asks first.
    if (!(await confirmLeave())) return
    router.push('/')
  }

  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />

      <nav className="border-b border-border bg-card px-5 print:hidden">
        <div className="flex items-center py-2">
          <Button
            variant="ghost"
            onClick={handleBack}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {back('dashboard')}
          </Button>
        </div>
      </nav>

      <main className="mx-auto w-full max-w-[1100px] p-5">
        <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <ProfileCard status={status} user={user} anonId={anonId} />
          <UsageCard />
          <DataExportCard />
          <DangerZoneCard user={user} />
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          {t('privacyNote')}{' '}
          <Link href="/privacy" className="text-primary hover:underline">
            {t('privacyPolicyLink')}
          </Link>
        </p>
      </main>
    </div>
  )
}
