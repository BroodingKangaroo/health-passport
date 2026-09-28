'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { PrintSetup } from '@/components/health-passport/print-setup'
import { Button } from '@/components/ui/button'
import { useLeaveGuard } from '@/providers/leave-guard-provider'
import { PrintSourceProvider } from '@/providers/print-source-provider'
import { createOwnerPrintSource } from '@/providers/print-source-owner'

export function PrintSetupView() {
  const t = useTranslations('print.view')
  const router = useRouter()
  const { confirmLeave } = useLeaveGuard()
  // The owner's print source: the authed endpoints, with the review dialog's
  // accepted terms persisted into the record's own dictionary.
  const source = useMemo(
    () => createOwnerPrintSource(() => router.push('/print-editor')),
    [router],
  )

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
        <PrintSourceProvider source={source}>
          <PrintSetup />
        </PrintSourceProvider>
      </main>
    </div>
  )
}
