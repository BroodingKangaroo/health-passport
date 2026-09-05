'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, Plus, X } from 'lucide-react'

import { cn, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useImportJobs } from '@/lib/hooks/useImportJobs'
import { ExtractionProgressCard } from './extraction-progress-card'
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

/**
 * Imports tracker (/imports): every caller job, newest-first, in two
 * sections — active work (queued/processing/failed/done, clickable as
 * before) and "Earlier imports" (saved + cancelled history rows, muted,
 * display-only apart from dismiss). Shares the ONE ['import-jobs'] poll
 * with the batch panel. Each row carries a metadata line (submitted/
 * extracted/failed/saved/cancelled time + file size); saved rows are kept
 * server-side as history (status='saved') instead of being deleted on save.
 * Click behavior: done → review editor, queued/processing → the
 * extraction-process view (the upload screen's stage visuals driven by job
 * progress; transitions into the review editor on completion), failed →
 * inline error + retry/dismiss.
 */
export function ImportsTracker() {
  const t = useTranslations('import')
  const tBack = useTranslations('misc.backLinks')
  const tUpload = useTranslations('upload')
  const locale = useLocale()
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
      case 'saved':
        return { label: t('trackerSaved') }
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

  function rowMeta(job: ImportJobSummary): string {
    // updated_at = the last transition: extraction completion for
    // done/failed, the save time for saved rows, submit for queued ones.
    const raw = job.status === 'queued' ? job.created_at : (job.updated_at ?? job.created_at)
    const time = raw ? formatDate(raw, locale) : ''
    const key =
      job.status === 'done'
        ? 'trackerMetaExtracted'
        : job.status === 'saved'
          ? 'trackerMetaSaved'
          : job.status === 'failed'
            ? 'trackerMetaFailed'
            : job.status === 'cancelled'
              ? 'trackerMetaCancelled'
              : 'trackerMetaSubmitted'
    const size =
      job.file_size >= 1024 * 1024
        ? `${(job.file_size / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(job.file_size / 1024))} KB`
    return `${t(key, { time })} · ${size}`
  }

  // ---- Extraction-process view for a clicked in-flight job ----
  if (selected && (selected.status === 'queued' || selected.status === 'processing')) {
    return (
      <div
        className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center"
        data-testid="import-progress-view"
      >
        {/* The upload screen's own extraction visuals, driven by the job's
            live progress (snapshot mode: fixed eta, no elapsed projection). */}
        <ExtractionProgressCard
          stage={
            (selected.status === 'processing' && STAGE_LABEL_KEYS[selected.stage]
              ? selected.stage
              : 'ocr_scanning') as 'ocr_scanning' | 'extracting' | 'matching'
          }
          biomarkerCount={selected.progress?.biomarker_count ?? null}
          elapsedSeconds={0}
          plannedEndSeconds={null}
          etaSeconds={selected.progress?.estimate_s ?? null}
          indeterminate
        />
        <p className="text-xs text-muted-foreground">{selected.original_filename}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busyId === selected.id}
            onClick={() => void act(selected.id, 'cancel')}
          >
            {t('trackerCancel')}
          </Button>
          <Button variant="ghost" onClick={() => setSelectedId(null)}>
            {t('batchBack')}
          </Button>
        </div>
      </div>
    )
  }

  const active = items.filter(
    (j) =>
      j.status === 'queued' ||
      j.status === 'processing' ||
      j.status === 'failed' ||
      j.status === 'done',
  )
  const history = items.filter((j) => j.status === 'saved' || j.status === 'cancelled')

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
        <>
          <ul className="space-y-2">
            {active.map((job) => (
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
                    {rowState(job).label}
                    {job.status === 'processing' && job.progress?.estimate_s != null && (
                      <>
                        {' '}
                        · {t('batchEta', { seconds: Math.max(1, Math.round(job.progress.estimate_s)) })}
                      </>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground/80" data-testid="row-meta">
                    {rowMeta(job)}
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
                      disabled={busyId === job.id}
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
                        disabled={busyId === job.id}
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
                        disabled={busyId === job.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          void act(job.id, 'dismiss')
                        }}
                      >
                        {t('trackerDismiss')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {history.length > 0 && (
            <>
              <h2
                className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                data-testid="imports-history-title"
              >
                {t('trackerHistoryTitle')}
              </h2>
              <ul className="space-y-1.5">
                {history.map((job) => (
                  <li
                    key={job.id}
                    className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2 opacity-80"
                    data-testid="imports-history-row"
                  >
                    {job.status === 'saved' ? (
                      <CheckCircle2 className="size-4 shrink-0 text-primary/70" />
                    ) : (
                      <X className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground/80">
                        {job.original_filename}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {job.status === 'saved' ? t('trackerSaved') : t('trackerCancelled')} ·{' '}
                        {rowMeta(job)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === job.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        void act(job.id, 'dismiss')
                      }}
                    >
                      {t('trackerDismiss')}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
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
