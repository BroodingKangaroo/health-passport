'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchFlowsheetData } from '@/services/api'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import { PrintEditor } from '@/components/health-passport/print-editor'
import type { FlowsheetResponse, PrintLang } from '@/lib/types'

export function PrintEditorView() {
  const router = useRouter()
  const { mode, targetLanguage, initFilters } = usePrintConfig()
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
        setError(err instanceof Error ? err.message : 'Failed to load flowsheet data')
      })
      .finally(() => setLoading(false))
  }, [])

  let lang: PrintLang = targetLanguage
  let bilingual = false
  if (mode === 'original') {
    lang = 'ru'
  } else if (mode === 'bilingual') {
    bilingual = true
  }

  if (loading) {
    return <div className="p-5 text-sm text-muted-foreground">Loading flowsheet data\u2026</div>
  }

  if (error || !data) {
    return (
      <div className="p-5 text-sm text-red-500">
        {error || 'Failed to load data.'}
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
      onBack={() => router.push('/print-setup')}
    />
  )
}
