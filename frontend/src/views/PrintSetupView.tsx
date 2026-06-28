'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { HeaderBar } from '@/components/health-passport/header-bar'
import { PrintSetup, type PrintLang } from '@/components/health-passport/print-setup'
import { Button } from '@/components/ui/button'

export function PrintSetupView() {
  const router = useRouter()

  return (
    <div className="min-h-screen bg-background">
      <HeaderBar />

      <nav className="border-b border-border bg-card px-5 print:hidden">
        <div className="flex items-center py-2">
          <Button
            variant="ghost"
            onClick={() => router.push('/')}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to Dashboard
          </Button>
        </div>
      </nav>

      <main className="p-5">
        <PrintSetup
          onGenerate={(lang, bilingual) => {
            const params = new URLSearchParams({ lang, bilingual: String(bilingual) })
            router.push(`/print-editor?${params}`)
          }}
        />
      </main>
    </div>
  )
}
