'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { fetchFlowsheetData } from '@/services/api'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import { useAuthStatus } from '@/components/providers/AuthStatusProvider'
import { PrintEditor } from '@/components/health-passport/print-editor'
import type { FlowsheetResponse, PrintLang } from '@/lib/types'

export function PrintEditorView() {
  const router = useRouter()
  const t = useTranslations('print.editorView')
  const { mode, targetLanguage, initFilters } = usePrintConfig()
  const { user } = useAuthStatus()
  const [data, setData] = useState<FlowsheetResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchFlowsheetData()
      .then((res: FlowsheetResponse) => {
        setData(res)
        const allDateLabels = res.dates.map((d) => d.label + (d.sub ? '--' + d.sub : ''))
        const allRowIds = res.matrix.flatMap((cat) => cat.rows.map((r) => r.id))
        initFilters(allDateLabels, allRowIds)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('failedToLoad'))
      })
      .finally(() => setLoading(false))
  }, [initFilters, t])

  let lang: PrintLang = targetLanguage
  let bilingual = false
  if (mode === 'original') {
    lang = 'ru'
  } else if (mode === 'bilingual') {
    bilingual = true
  }

  if (loading) {
    return <div className="p-5 text-sm text-muted-foreground">{t('loading')}</div>
  }

  if (error || !data) {
    return (
      <div className="p-5 text-sm text-red-500">
        {error || t('failedToLoad')}
      </div>
    )
  }

  return (
    <PrintEditor
      dates={[...data.dates]}
      matrix={data.matrix}
      biomarkers={data.biomarkers}
      lang={lang}
      bilingual={bilingual}
      patient={user}
      onBack={() => router.push('/print-setup')}
    />
  )
}
