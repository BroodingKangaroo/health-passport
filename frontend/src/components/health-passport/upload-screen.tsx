'use client'

import { useState, useRef } from 'react'
import { UploadCloud, Pencil, AlertCircle, ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ExtractionProgressCard } from './extraction-progress-card'
import type { UploadState, ProgressStage } from '@/lib/types'

const docPills = [
  { emoji: '📄', labelKey: 'pillLab' },
  { emoji: '📝', labelKey: 'pillDoctor' },
  { emoji: '🩻', labelKey: 'pillInstrumental' },
] as const

interface UploadScreenProps {
  uploadState: UploadState
  progressStage: ProgressStage
  biomarkerCount: number | null
  elapsedSeconds: number
  plannedEndSeconds: number | null
  multiFileNotice: string | null
  onFiles: (files: FileList | null) => void
  onStartManual: () => void
}

export function UploadScreen({
  uploadState,
  progressStage,
  biomarkerCount,
  elapsedSeconds,
  plannedEndSeconds,
  multiFileNotice,
  onFiles,
  onStartManual,
}: UploadScreenProps) {
  const [dragActive, setDragActive] = useState(false)
  const uploadFileRef = useRef<HTMLInputElement>(null)
  const t = useTranslations('upload')

  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    onFiles(e.target.files)
    e.target.value = ''
  }

  function handleDragOver(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function handleDragEnter(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    if (uploadState === 'idle') setDragActive(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setDragActive(false)
  }

  function handleDrop(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setDragActive(false)
    if (uploadState !== 'idle') return
    onFiles(e.dataTransfer.files)
  }

  return (
    <div className="mx-auto max-w-3xl py-4">
      <div className="mb-6 text-center">
        <h1 className="text-balance text-2xl font-bold text-foreground">
          {t('title')}
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-pretty text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      <input
        ref={uploadFileRef}
        type="file"
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.tiff,.tif,.bmp"
        // Batch import: the picker (like the dropzone) accepts several files;
        // >1 routes to the background-jobs batch panel in add-entry.
        multiple
        onChange={handleFilePicked}
      />

      <button
        type="button"
        onClick={() => uploadState === 'idle' && uploadFileRef.current?.click()}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        disabled={uploadState === 'scanning'}
        className={cn(
          'w-full rounded-xl border-2 border-dashed border-primary/30 bg-accent/40 p-12 text-center transition',
          dragActive && 'border-primary bg-accent/80 ring-2 ring-primary/40',
          uploadState === 'idle' && 'cursor-pointer hover:bg-accent/70',
        )}
      >
        {uploadState === 'idle' ? (
          <div className="flex flex-col items-center gap-4">
            <div className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UploadCloud className="size-8" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">
                {t('dropzone')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('formats')}</p>
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              {docPills.map((p) => (
                <span
                  key={p.labelKey}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground"
                >
                  <span aria-hidden>{p.emoji}</span>
                  {t(p.labelKey)}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <ExtractionProgressCard
            stage={progressStage}
            biomarkerCount={biomarkerCount}
            elapsedSeconds={elapsedSeconds}
            plannedEndSeconds={plannedEndSeconds}
          />
        )}
      </button>

      {multiFileNotice && (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {multiFileNotice}
        </p>
      )}

      {uploadState === 'idle' && (
        <>
          <p className="mx-auto mt-3 flex max-w-md items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            {t('aiDisclosure')}
          </p>

          <div className="relative my-6">
            <div className="border-t border-border" />
            <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 bg-background px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('or')}
            </span>
          </div>

          <Button variant="outline" size="lg" onClick={onStartManual} className="w-full gap-2">
            <Pencil className="size-4" />
            {t('skipManual')}
          </Button>
        </>
      )}
    </div>
  )
}
