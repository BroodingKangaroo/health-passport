'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { FileJson, FileSpreadsheet, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { downloadAccountExport } from '@/services/api'

export function DataExportCard() {
  const t = useTranslations('settings.data')
  const [busy, setBusy] = useState<'json' | 'csv' | null>(null)

  async function handle(format: 'json' | 'csv') {
    setBusy(format)
    try {
      await downloadAccountExport(format)
    } catch (e) {
      toast.error(t('downloadFailed'), {
        description: e instanceof Error && e.message ? e.message : undefined,
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="p-6" data-testid="data-export-card">
      <div className="mb-4 flex items-center gap-2">
        <Download className="size-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {t('title')}
        </h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('description')}</p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => handle('json')}
          disabled={busy !== null}
          data-testid="export-json"
        >
          <FileJson className="size-3.5" />
          {busy === 'json' ? t('downloading') : t('downloadJson')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handle('csv')}
          disabled={busy !== null}
          data-testid="export-csv"
        >
          <FileSpreadsheet className="size-3.5" />
          {busy === 'csv' ? t('downloading') : t('downloadCsv')}
        </Button>
      </div>
    </Card>
  )
}
