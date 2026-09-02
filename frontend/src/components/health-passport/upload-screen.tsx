'use client'

import { useState, useRef } from 'react'
import { UploadCloud, Loader2, Pencil, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { UploadState, ProgressStage } from '@/lib/types'

const docPills = [
  { emoji: '📄', labelKey: 'pillLab' },
  { emoji: '📝', labelKey: 'pillDoctor' },
  { emoji: '🩻', labelKey: 'pillInstrumental' },
] as const

const stageStep: Record<ProgressStage, number> = {
  ocr_scanning: 1,
  extracting: 2,
  matching: 3,
  completed: 4,
}
const totalSteps = 3
// Seconds past the projection before "almost done…" is swapped for an honest
// "taking longer than usual" message — the projection is a median, so a brief
// overshoot is normal and shouldn't alarm anyone.
const OVERSHOOT_GRACE_S = 4

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

  const stageInfo: Record<ProgressStage, { label: string; detail: string }> = {
    ocr_scanning: { label: t('stageOcrLabel'), detail: t('stageOcrDetail') },
    extracting: { label: t('stageExtractLabel'), detail: t('stageExtractDetail') },
    matching: { label: t('stageMatchLabel'), detail: t('stageMatchDetail') },
    completed: { label: t('stageDoneLabel'), detail: t('stageDoneDetail') },
  }

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

  let progressWidth: number
  let remainingSeconds: number | null = null
  let overshooting = false

  if (progressStage === 'completed') {
    progressWidth = 100
    remainingSeconds = 0
  } else if (plannedEndSeconds !== null && plannedEndSeconds > 0) {
    // Cumulative projection: the countdown and bar span ALL remaining work
    // (extraction + matching), so neither resets when a stage hands off to
    // the next — the projection is ratcheted to only move earlier.
    remainingSeconds = Math.max(0, plannedEndSeconds - elapsedSeconds)
    overshooting = remainingSeconds === 0 && elapsedSeconds - plannedEndSeconds > OVERSHOOT_GRACE_S
    progressWidth = Math.min(95, (elapsedSeconds / plannedEndSeconds) * 100)
  } else {
    // OCR phase (or a stage whose estimate hasn't arrived yet).
    progressWidth = 2
  }

  const stageDetail =
    progressStage === 'matching' && biomarkerCount !== null
      ? t('stageMatchDetailCounted', { count: biomarkerCount })
      : stageInfo[progressStage].detail

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
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="relative size-10">
              <div
                className={`absolute inset-0 transition-all duration-400 ease-out ${
                  progressStage === 'completed' ? 'scale-50 opacity-0' : 'scale-100 opacity-100'
                }`}
              >
                <Loader2 className="size-10 animate-spin text-primary" />
              </div>
              <div
                className={`absolute inset-0 flex items-center justify-center ${
                  progressStage === 'completed'
                    ? 'animate-[scale-in_0.5s_cubic-bezier(0.34,1.56,0.64,1)_forwards]'
                    : 'scale-0 opacity-0'
                }`}
              >
                <CheckCircle2 className="size-10 text-primary" />
              </div>
            </div>
            <p className="text-sm font-semibold text-foreground">{stageInfo[progressStage].label}</p>
            <p className="max-w-sm text-pretty text-xs text-muted-foreground">{stageDetail}</p>
            <div className="mt-1 w-full max-w-xs space-y-1.5">
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-primary/10"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progressWidth)}
                aria-label={stageInfo[progressStage].label}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
                  style={{ width: `${progressWidth}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {progressStage === 'completed' ? (
                  t('complete')
                ) : (
                  <>
                    {t('stepOf', { step: stageStep[progressStage], total: totalSteps })}
                    {remainingSeconds === null ? (
                      <> {t('estimating')}</>
                    ) : overshooting ? (
                      <> {t('slowerThanUsual', { seconds: elapsedSeconds })}</>
                    ) : remainingSeconds === 0 ? (
                      <> {t('almostDone')}</>
                    ) : (
                      <> {t('secondsRemaining', { seconds: remainingSeconds })}</>
                    )}
                  </>
                )}
              </p>
            </div>
          </div>
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
