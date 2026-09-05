'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, Plus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useImportJobs } from '@/lib/hooks/useImportJobs'
import {
  cancelImportJob,
  dismissImportJob,
  retryImportJob,
  type ImportJobSummary,
} from '@/services/import-jobs'

const STAGE_LABEL_KEYS: Record<string, 'stageOcrLabel' | 'stageExtractLabel' | 'stageMatchLabel'> = {
  ocr_scanning: 'stageOcrLabel',
  extracting: 'stageExtractLabel',
  matching: 'stageMatchLabel',
}

const STAGE_STEP: Record<string, number> = {
  ocr_scanning: 1,
  extracting: 2,
  matching: 3,
}

/**
 * Imports tracker (/imports): every caller job with live status, sorted
 * newest-first. Shares the ONE ['import-jobs'] poll with the batch panel
 * (lib/hooks/useImportJobs), so both surfaces stay in sync. Click behavior:
 * done → review editor, queued/processing → the extraction-process view
 * (the upload screen's stage visuals driven by job progress; transitions
 * into the review editor on completion), failed → inline error +
 * retry/dismiss. Saved jobs are deleted server-side on save, so the page
 * shows only actionable work + in-flight/failed items — no stale history.
 */
export function ImportsTracker() {
  const t = useTranslations('import')
  const tBack = useTranslations('misc.backLinks')
  const tUpload = useTranslations('upload')
  const router = useRouter()
  const jobsQuery = useImportJobs(3000, true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const items = useMemo(() => jobsQuery.data?.items ?? [], [jobsQuery.data])
  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  )

  // A job completing in the extraction-process view transitions straight
  // into the review editor — same experience as the SSE flow, resumable.
  useEffect(() => {
    if (selected?.status === 'done') {
      router.push(`/review-import?job=${selected.id}`)
    }
  }, [selected, router])

  async function act(id: string, action: 'cancel' | 'retry' | 'dismiss') {
    setBusyId(id)
    try {
      if (action === 'cancel') await cancelImportJob(id)
      if (action === 'retry') await retryImportJob(id)
      if (action === 'dismiss') await dismissImportJob(id)
      await jobsQuery.refetch()
    } catch {
      /* row keeps its last known state */
    } finally {
      setBusyId(null)
    }
  }

  function rowState(job: ImportJobSummary): { label: string } {
    switch (job.status) {
      case 'done':
        return { label: t('trackerDone') }
      case 'failed':
        return { label: job.error ?? t('trackerFailed') }
      case 'cancelled':
        return { label: t('trackerCancelled') }
      case 'processing': {
        const key = STAGE_LABEL_KEYS[job.stage]
        return { label: key ? tUpload(key) : t('trackerQueued') }
      }
      default:
        return { label: t('trackerQueued') }
    }
  }

  // ---- Extraction-process view for a clicked in-flight job ----
  if (selected && (selected.status === 'queued' || selected.status === 'processing')) {
    const stageKey = STAGE_LABEL_KEYS[selected.stage]
    const step = STAGE_STEP[selected.stage] ?? 1
    const eta = selected.progress?.estimate_s
    return (
      <div
        className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center"
        data-testid="import-progress-view"
      >
        <Loader2 className="size-10 animate-spin text-primary" />
        <p className="text-sm font-semibold text-foreground">
          {selected.status === 'processing' && stageKey
            ? tUpload(stageKey)
            : t('trackerQueued')}
        </p>
        <p className="text-xs text-muted-foreground">{selected.original_filename}</p>
        <div className="w-full max-w-xs">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-primary/10"
            role="progressbar"
            aria-label={t('trackerQueued')}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
              style={{
                width: selected.status === 'processing' ? `${Math.min(95, step * 30)}%` : '2%',
              }}
            />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {tUpload('stepOf', { step, total: 3 })}
            {eta != null && <> · {t('batchEta', { seconds: Math.max(1, Math.round(eta)) })}</>}
          </p>
        </div>
        <Button variant="ghost" onClick={() => setSelectedId(null)}>
          {t('batchBack')}
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl py-4" data-testid="imports-tracker">
      <div className="mb-5 text-center">
        <h1 className="text-balance text-2xl font-bold text-foreground">{t('trackerTitle')}</h1>
        <p className="mx-auto mt-2 max-w-xl text-pretty text-sm text-muted-foreground">
          {t('trackerSubtitle')}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center" data-testid="imports-empty">
          <p className="text-sm text-muted-foreground">{t('trackerEmpty')}</p>
          <Link
            href="/add-entry"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            <Plus className="size-4" />
            {t('trackerImportOne')}
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((job) => {
            const state = rowState(job)
            const busy = busyId === job.id
            return (
              <li
                key={job.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5',
                  (job.status === 'done' ||
                    job.status === 'queued' ||
                    job.status === 'processing') &&
                    'cursor-pointer hover:bg-accent/60',
                )}
                onClick={() => {
                  if (job.status === 'done') router.push(`/review-import?job=${job.id}`)
                  if (job.status === 'queued' || job.status === 'processing')
                    setSelectedId(job.id)
                }}
                data-testid="imports-row"
              >
                {job.status === 'done' ? (
                  <CheckCircle2 className="size-5 shrink-0 text-primary" />
                ) : job.status === 'failed' ? (
                  <AlertCircle className="size-5 shrink-0 text-status-high" />
                ) : job.status === 'cancelled' ? (
                  <X className="size-5 shrink-0 text-muted-foreground" />
                ) : (
                  <Loader2 className="size-5 shrink-0 animate-spin text-primary" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {job.original_filename}
                  </p>
                  <p
                    className={cn(
                      'truncate text-xs',
                      job.status === 'failed' ? 'text-status-high' : 'text-muted-foreground',
                    )}
                  >
                    {state.label}
                    {job.status === 'processing' && job.progress?.estimate_s != null && (
                      <>
                        {' '}
                        · {t('batchEta', { seconds: Math.max(1, Math.round(job.progress.estimate_s)) })}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {job.status === 'done' && (
                    <Link
                      href={`/review-import?job=${job.id}`}
                      className="text-xs font-semibold text-primary underline underline-offset-2"
                      data-testid="row-review"
                    >
                      {t('trackerReview')}
                    </Link>
                  )}
                  {(job.status === 'queued' || job.status === 'processing') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation()
                        void act(job.id, 'cancel')
                      }}
                    >
                      {t('trackerCancel')}
                    </Button>
                  )}
                  {job.status === 'failed' && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation()
                          void act(job.id, 'retry')
                        }}
                      >
                        {t('trackerRetry')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation()
                          void act(job.id, 'dismiss')
                        }}
                      >
                        {t('trackerDismiss')}
                      </Button>
                    </>
                  )}
                  {job.status === 'cancelled' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation()
                        void act(job.id, 'dismiss')
                      }}
                    >
                      {t('trackerDismiss')}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-6 text-center">
        <Button variant="ghost" onClick={() => router.push('/')}>
          <ArrowLeft className="size-4" />
          {tBack('dashboard')}
        </Button>
      </div>
    </div>
  )
}
