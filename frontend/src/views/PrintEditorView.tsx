'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { fetchFlowsheetData } from '@/services/api'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import { useAuthStatus } from '@/components/providers/AuthStatusProvider'
import { PrintEditor } from '@/components/health-passport/print-editor'
import { dateId } from '@/lib/print-document'
import type { FlowsheetResponse, PrintLang } from '@/lib/types'

export function PrintEditorView() {
  const router = useRouter()
  const t = useTranslations('print.editorView')
  const { mode, targetLanguage, initFilters } = usePrintConfig()
  const { user } = useAuthStatus()
  const [data, setData] = useState<FlowsheetResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The initial fetch + filter initialization must run ONCE per mount and
  // must NOT re-run on locale switches: `initFilters` overwrites the user's
  // column/row selections, so re-running on `t` identity changes (locale)
  // would silently reset them (ISSUES.md #75). The failure message reads the
  // current translator through a ref so the effect has no locale dependency.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  useEffect(() => {
    fetchFlowsheetData()
      .then((res: FlowsheetResponse) => {
        setData(res)
        const allDateLabels = res.dates.map(dateId)
        const allRowIds = res.matrix.flatMap((cat) => cat.rows.map((r) => r.id))
        initFilters(allDateLabels, allRowIds)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : tRef.current('failedToLoad'))
      })
      .finally(() => setLoading(false))
  }, [initFilters])

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
