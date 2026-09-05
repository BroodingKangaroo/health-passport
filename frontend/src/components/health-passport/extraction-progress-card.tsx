'use client'

import { Loader2, CheckCircle2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { ProgressStage } from '@/lib/types'

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

/**
 * The extraction-in-progress visuals shared by the single-document upload
 * screen (live mode: elapsed + ratcheted planned end) and the imports
 * tracker's in-flight view (snapshot mode: a fixed eta from the job's
 * `progress.estimate_s`, indeterminate bar). ONE source of truth for the
 * look: spinner↔checkmark swap, stage label, detail line, progress bar and
 * the step N-of-3 + countdown copy.
 */
export function ExtractionProgressCard({
  stage,
  biomarkerCount,
  elapsedSeconds,
  plannedEndSeconds,
  etaSeconds,
  indeterminate = false,
}: {
  stage: ProgressStage
  biomarkerCount: number | null
  /** Live mode only: seconds elapsed since the scan started. */
  elapsedSeconds: number
  /** Live mode only: ratcheted projected finish (elapsed-seconds terms). */
  plannedEndSeconds: number | null
  /** Snapshot mode: fixed eta from the job progress (replaces the countdown). */
  etaSeconds?: number | null
  /** Snapshot mode: soft bar width (no elapsed to project from). */
  indeterminate?: boolean
}) {
  const t = useTranslations('upload')

  const stageInfo: Record<ProgressStage, { label: string; detail: string }> = {
    ocr_scanning: { label: t('stageOcrLabel'), detail: t('stageOcrDetail') },
    extracting: { label: t('stageExtractLabel'), detail: t('stageExtractDetail') },
    matching: { label: t('stageMatchLabel'), detail: t('stageMatchDetail') },
    completed: { label: t('stageDoneLabel'), detail: t('stageDoneDetail') },
  }

  let progressWidth: number
  let remainingSeconds: number | null = null
  let overshooting = false

  if (stage === 'completed') {
    progressWidth = 100
    remainingSeconds = 0
  } else if (indeterminate) {
    // Snapshot mode (job progress, no elapsed timer): soft advancing width.
    progressWidth = Math.min(95, stageStep[stage] * 30)
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
    stage === 'matching' && biomarkerCount !== null
      ? t('stageMatchDetailCounted', { count: biomarkerCount })
      : stageInfo[stage].detail

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="relative size-10">
        <div
          className={`absolute inset-0 transition-all duration-400 ease-out ${
            stage === 'completed' ? 'scale-50 opacity-0' : 'scale-100 opacity-100'
          }`}
        >
          <Loader2 className="size-10 animate-spin text-primary" />
        </div>
        <div
          className={`absolute inset-0 flex items-center justify-center ${
            stage === 'completed'
              ? 'animate-[scale-in_0.5s_cubic-bezier(0.34,1.56,0.64,1)_forwards]'
              : 'scale-0 opacity-0'
          }`}
        >
          <CheckCircle2 className="size-10 text-primary" />
        </div>
      </div>
      <p className="text-sm font-semibold text-foreground">{stageInfo[stage].label}</p>
      <p className="max-w-sm text-pretty text-xs text-muted-foreground">{stageDetail}</p>
      <div className="mt-1 w-full max-w-xs space-y-1.5">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-primary/10"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressWidth)}
          aria-label={stageInfo[stage].label}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
            style={{ width: `${progressWidth}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {stage === 'completed' ? (
            t('complete')
          ) : (
            <>
              {t('stepOf', { step: stageStep[stage], total: totalSteps })}
              {indeterminate && etaSeconds != null ? (
                <> {t('secondsRemaining', { seconds: Math.max(1, Math.round(etaSeconds)) })}</>
              ) : remainingSeconds === null ? (
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
  )
}
