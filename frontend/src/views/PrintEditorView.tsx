'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { PrintEditor } from '@/components/health-passport/print-editor'

export function PrintEditorView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const lang = (searchParams.get('lang') as 'ru' | 'en' | 'de' | 'fr' | 'es' | 'he') || 'ru'
  const bilingual = searchParams.get('bilingual') === 'true'

  return (
    <PrintEditor
      lang={lang}
      bilingual={bilingual}
      onBack={() => router.push('/print-setup')}
    />
  )
}
