'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, Plus, X } from 'lucide-react'

import { cn, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useImportJobs } from '@/lib/hooks/useImportJobs'
import { getNewImportJobIds, markImportJobSeen } from '@/lib/new-import-jobs'
import { ExtractionProgressCard } from './extraction-progress-card'
import {
  cancelImportJob,
  dismissImportJob,
  restoreImportJob,
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
 * before) and "Earlier imports" (saved + cancelled + dismissed rows,
 * muted, collapsed behind a toggle — auto-expanded while it holds a
 * restorable dismissed row). Shares the ONE ['import-jobs'] poll with the
 * batch panel. Each row carries a metadata line (submitted/extracted/
 * failed/saved/cancelled time + file size); saved rows are kept server-side
 * as history (status='saved') instead of being deleted on save. Click
 * behavior: done → review editor, queued/processing → the extraction-
 * process view (the upload screen's stage visuals driven by job progress;
 * transitions into the review editor on completion), failed → inline error
 * + retry/dismiss. Done rows warn when the staged record overlaps a
 * same-date entry (merge would be refused); restorable dismissed rows offer
 * Restore (revives the extraction back into the active list).
 */
export function ImportsTracker() {
  const t = useTranslations('import')
  const tUpload = useTranslations('upload')
  const locale = useLocale()
  const router = useRouter()
  const jobsQuery = useImportJobs(3000, true)
  // /imports?focus=<jobId>: auto-open a just-submitted job's progress view
  // (the single-file submit path lands here).
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('focus'),
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  // "Earlier imports" collapse: null = auto (expanded only while the
  // section holds a restorable dismissed row — the Restore affordance must
  // stay discoverable); any explicit toggle wins from then on.
  const [historyOverride, setHistoryOverride] = useState<boolean | null>(null)
  // Jobs submitted from /add-entry that have not been opened yet (#76
  // rework): badged as new until each is viewed (progress view, review
  // editor or the in-view auto-transition), so fresh extractions are
  // recognisable from previously added and viewed ones. Read per render
  // (not mirrored into state): every markImportJobSeen is paired with a
  // re-render trigger — a selection change or a navigation — so the pill
  // clears exactly when the job is opened.
  const newIds = getNewImportJobIds()

  const items = useMemo(() => jobsQuery.data?.items ?? [], [jobsQuery.data])
  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  )

  // Opening a job (the focused redirect or a row click into the progress
  // view) counts as viewing it — the New badge goes away.
  useEffect(() => {
    if (!selectedId) return
    markImportJobSeen(selectedId)
  }, [selectedId])

  // A job completing in the extraction-process view transitions straight
  // into the review editor — same experience as the SSE flow, resumable.
  useEffect(() => {
    if (selected?.status === 'done') {
      markImportJobSeen(selected.id)
      router.push(`/review-import?job=${selected.id}`)
    }
  }, [selected, router])

  async function act(
    id: string,
    action: 'cancel' | 'retry' | 'dismiss' | 'restore',
  ) {
    setBusyId(id)
    try {
      if (action === 'restore') {
        await restoreImportJob(id)
        toast.success(t('trackerRestoredToast'))
      } else {
        if (action === 'cancel') await cancelImportJob(id)
        if (action === 'retry') await retryImportJob(id)
        if (action === 'dismiss') await dismissImportJob(id)
      }
    } catch {
      /* row keeps its last known state */
      if (action === 'restore') toast.error(t('trackerRestoreFailed'))
    } finally {
      // A failed refetch must not misreport a completed restore as failed —
      // the shared poll recovers on its next tick anyway.
      try {
        await jobsQuery.refetch()
      } catch {
        /* ignore */
      }
      setBusyId(null)
    }
  }

  function rowState(job: ImportJobSummary): { label: string } {
    switch (job.status) {
      case 'done':
        return { label: t('trackerDone') }
      case 'saved':
        return { label: t('trackerSaved') }
      case 'dismissed':
        return { label: t('trackerDismissed') }
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
    // done/failed, the save/dismiss time for history rows, submit for
    // queued ones. No status word — the label sits next to it (#4).
    const raw = job.status === 'queued' ? job.created_at : (job.updated_at ?? job.created_at)
    const time = raw ? formatDate(raw, locale) : ''
    const size =
      job.file_size >= 1024 * 1024
        ? `${(job.file_size / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(job.file_size / 1024))} KB`
    return `${time} · ${size}`
  }

  // ---- Extraction-process view for a clicked in-flight job ----
  if (selected && (selected.status === 'queued' || selected.status === 'processing')) {
    return (
      <div className="mx-auto max-w-3xl py-4" data-testid="import-progress-view">
        {/* Same container styling as the upload screen's scanning state —
            the in-progress view IS the single-extraction screen, driven by
            the job's live progress (snapshot mode: fixed eta). */}
        <div className="rounded-xl border-2 border-dashed border-primary/30 bg-accent/40 p-12 text-center transition">
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
        </div>
        <div className="mt-4 flex flex-col items-center gap-3">
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
  const history = items.filter(
    (j) => j.status === 'saved' || j.status === 'cancelled' || j.status === 'dismissed',
  )

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
                  if (job.status === 'done') {
                    markImportJobSeen(job.id)
                    router.push(`/review-import?job=${job.id}`)
                  }
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
                  <div className="flex min-w-0 items-center gap-1.5">
                    <p className="truncate text-sm font-medium text-foreground">
                      {job.original_filename}
                    </p>
                    {newIds.includes(job.id) && (
                      <span
                        className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
                        data-testid="row-new"
                      >
                        {t('trackerNew')}
                      </span>
                    )}
                  </div>
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
                  {job.status === 'done' &&
                    !!job.merge_conflicts?.length && (
                      <p
                        className="mt-0.5 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500"
                        data-testid="row-merge-warning"
                        // Full analyte list on hover — the row itself stays one line.
                        title={job.merge_conflicts.join(', ')}
                      >
                        <AlertTriangle className="size-3.5 shrink-0" />
                        <span className="min-w-0 truncate">
                          {t('mergeOverlapWarning', { count: job.merge_conflicts.length })}
                        </span>
                      </p>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {job.status === 'done' && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="hover:bg-primary/20 hover:text-primary hover:border-primary/50"
                        onClick={(e) => {
                          e.stopPropagation()
                          router.push(`/review-import?job=${job.id}`)
                        }}
                        data-testid="row-review"
                      >
                        {t('trackerReview')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === job.id}
                        className="hover:bg-destructive/10 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          void act(job.id, 'dismiss')
                        }}
                      >
                        {t('trackerDismiss')}
                      </Button>
                    </>
                  )}
                  {(job.status === 'queued' || job.status === 'processing') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === job.id}
                      className="hover:bg-destructive/10 hover:text-destructive"
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
                        className="hover:bg-destructive/10 hover:text-destructive"
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

          {history.length > 0 &&
            (() => {
              const restorableCount = history.filter((j) => j.restorable).length
              const historyOpen = historyOverride ?? restorableCount > 0
              return (
                <>
                  <div className="mb-2 mt-6" data-testid="imports-history-title">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setHistoryOverride(!historyOpen)}
                      className="gap-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                      aria-expanded={historyOpen}
                      data-testid="imports-history-toggle"
                    >
                      {historyOpen ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                      {historyOpen
                        ? t('trackerHistoryTitle')
                        : t('trackerShowHistory', { count: history.length })}
                    </Button>
                  </div>
                  {historyOpen && (
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
                            {/* Status word + plain time/size — the label and the
                                timestamp are not duplicated (#4). */}
                            <p className="truncate text-[11px] text-muted-foreground">
                              {job.status === 'saved'
                                ? t('trackerSaved')
                                : job.status === 'dismissed'
                                  ? t('trackerDismissed')
                                  : t('trackerCancelled')}{' '}
                              · {rowMeta(job)}
                            </p>
                          </div>
                          {job.restorable && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyId === job.id}
                              className="shrink-0 hover:bg-primary/20 hover:text-primary"
                              onClick={() => void act(job.id, 'restore')}
                              data-testid="row-restore"
                            >
                              {t('trackerRestore')}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
            })()}
        </>
      )}
    </div>
  )
}
