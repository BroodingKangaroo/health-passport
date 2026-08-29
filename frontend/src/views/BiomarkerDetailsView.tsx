'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { BiomarkerDetails } from '@/components/health-passport/biomarker-details'
import { Button } from '@/components/ui/button'

export function BiomarkerDetailsView() {
  const router = useRouter()
  const t = useTranslations('misc.backLinks')
  const searchParams = useSearchParams()
  const from = searchParams.get('from')
  const backPath = from === 'flowsheet' ? '/flowsheet' : '/'
  const backLabel = from === 'flowsheet' ? t('flowsheet') : t('timeline')

  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />

      <nav className="border-b border-border bg-card px-5 print:hidden">
        <div className="flex items-center py-2">
          <Button
            variant="ghost"
            onClick={() => router.push(backPath)}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {backLabel}
          </Button>
        </div>
      </nav>

      <main className="p-5">
        <BiomarkerDetails />
      </main>
    </div>
  )
}
