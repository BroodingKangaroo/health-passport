'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { PrintSetup } from '@/components/health-passport/print-setup'
import { Button } from '@/components/ui/button'
import { useLeaveGuard } from '@/providers/leave-guard-provider'

export function PrintSetupView() {
  const t = useTranslations('print.view')
  const router = useRouter()
  const { confirmLeave } = useLeaveGuard()

  async function handleBack() {
    // While the AI translation is running, leaving cancels it — ask first.
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
            {t('backToDashboard')}
          </Button>
        </div>
      </nav>

      <main className="p-5">
        <PrintSetup />
      </main>
    </div>
  )
}
