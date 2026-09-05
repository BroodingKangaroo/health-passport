'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { AlertCircle, CheckCircle2, FileText, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useImportJobs } from '@/lib/hooks/useImportJobs'
import {
  cancelImportJob,
  createImportJob,
  dismissImportJob,
  retryImportJob,
  type ImportJobSummary,
} from '@/services/import-jobs'
import { fetchUsageLimits, ApiError } from '@/services/api'

interface RowState {
  file: File
  jobId: string | null
  /** Non-null = the submit call itself failed (row is retryable). */
  submitError: string | null
}

const STAGE_LABEL_KEYS: Record<string, 'stageOcrLabel' | 'stageExtractLabel' | 'stageMatchLabel'> = {
  ocr_scanning: 'stageOcrLabel',
  extracting: 'stageExtractLabel',
  matching: 'stageMatchLabel',
}

/**
 * Batch import mode on /add-entry: dropping >1 file lands here — one
 * background extraction job per document with live per-row progress (the
 * upload screen's stage visuals driven by job progress instead of the SSE
 * stream), capped (not shotgun) submission, per-row cancel/retry/remove and
 * a leave hint instead of the leave-guard (nothing is lost by leaving —
 * extraction continues server-side). The single-file SSE flow is untouched.
 */
export function BatchImportPanel({
  files,
  onBack,
}: {
  files: File[]
  onBack: () => void
}) {
  const t = useTranslations('import')
  const tUpload = useTranslations('upload')
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<RowState[]>(() =>
    files.map((file) => ({ file, jobId: null, submitError: null })),
  )
  // Remaining extractions at panel mount (from /usage/limits). Null until
  // the fetch resolves; a failed fetch blocks submission (fail closed —
  // without limits the batch cannot be capped).
  const [quota, setQuota] = useState<{ remaining: number; limit: number; isAnon: boolean } | null>(
    null,
  )
  const [quotaError, setQuotaError] = useState(false)
  const [submittedCount, setSubmittedCount] = useState(0)
  const submittingRef = useRef(false)

  const jobsQuery = useImportJobs(3000, true)

  // ---- Submission: capped, not shotgun ----
  // Submit min(N, remaining) jobs SEQUENTIALLY; files beyond the limit stay
  // picked (rendered as the disabled "register to import" group) for after
  // registration. A submit failure stops the loop — never fire-all-and-eat-429s.
  useEffect(() => {
    let cancelled = false
    submittingRef.current = true
    ;(async () => {
      let cap = 0
      try {
        const limits = await fetchUsageLimits()
        const remaining = Math.max(
          0,
          limits.ai_extraction_limit - limits.ai_extraction_count,
        )
        setQuota({ remaining, limit: limits.ai_extraction_limit, isAnon: limits.is_anonymous })
        setQuotaError(false)
        cap = Math.min(rows.length, remaining)
      } catch {
        setQuotaError(true)
        submittingRef.current = false
        return
      }
      for (let i = 0; i < cap; i++) {
        if (cancelled) return
        try {
          const jobId = await createImportJob(rows[i].file)
          if (cancelled) return
          setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, jobId } : r)))
          setSubmittedCount((n) => n + 1)
        } catch (err) {
          if (cancelled) return
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? {
                    ...r,
                    submitError:
                      err instanceof ApiError
                        ? err.message
                        : t('batchSubmitFailed', { error: '' }),
                  }
                : r,
            ),
          )
          break
        }
      }
      submittingRef.current = false
      // Surface this batch's rows in the shared poll immediately.
      queryClient.invalidateQueries({ queryKey: ['import-jobs'] })
    })()
    return () => {
      cancelled = true
      submittingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Submissions are in flight while the initial upload loop is still running
  // (uploads not yet accepted) — the only leave prompt in batch mode.
  const submissionsInFlight = quota === null && !quotaError
  useEffect(() => {
    if (!submissionsInFlight) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [submissionsInFlight])

  const jobById = useMemo(() => {
    const map = new Map<string, ImportJobSummary>()
    for (const item of jobsQuery.data?.items ?? []) map.set(item.id, item)
    return map
  }, [jobsQuery.data])

  function setRow(idx: number, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  async function handleCancel(idx: number) {
    const row = rows[idx]
    if (!row.jobId) return
    try {
      await cancelImportJob(row.jobId)
      await jobsQuery.refetch()
    } catch {
      /* row keeps its last known state */
    }
  }

  async function handleRetry(idx: number) {
    const row = rows[idx]
    if (!row.jobId) return
    try {
      await retryImportJob(row.jobId)
      setRow(idx, { submitError: null })
      await jobsQuery.refetch()
    } catch {
      /* stays failed */
    }
  }

  async function handleRemove(idx: number) {
    const row = rows[idx]
    if (row.jobId) {
      try {
        await dismissImportJob(row.jobId)
      } catch {
        /* fall through to local removal */
      }
    }
    setRows((prev) => prev.filter((_, i) => i !== idx))
    await jobsQuery.refetch()
  }

  function rowView(row: RowState, idx: number) {
    const job = row.jobId ? jobById.get(row.jobId) : undefined
    const status = job?.status ?? (row.jobId ? 'queued' : null)
    const isTerminal = status === 'done' || status === 'failed' || status === 'cancelled'
    const etaSeconds = job?.progress?.estimate_s

    let stateLabel: string
    if (row.submitError !== null) {
      stateLabel = t('batchSubmitFailed', { error: row.submitError })
    } else if (status === 'done') {
      stateLabel = t('batchDone')
    } else if (status === 'failed') {
      stateLabel = job?.error ?? t('batchFailed')
    } else if (status === 'cancelled') {
      stateLabel = t('batchCancelled')
    } else if (status === null) {
      // Never submitted (over quota): the disabled "register to import" group.
      stateLabel = t('batchOverLimit', { count: 1 })
    } else {
      // queued / processing: the upload screen's stage visuals.
      const stageKey = STAGE_LABEL_KEYS[job?.stage ?? '']
      stateLabel =
        status === 'processing' && stageKey ? tUpload(stageKey) : t('batchWaiting')
    }

    return (
      <li
        key={row.file.name + idx}
        className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
        data-testid="batch-row"
      >
        {status !== null && status !== 'done' && status !== 'failed' && status !== 'cancelled' ? (
          <Loader2 className="size-5 shrink-0 animate-spin text-primary" />
        ) : status === 'done' ? (
          <CheckCircle2 className="size-5 shrink-0 text-primary" />
        ) : (
          <FileText className="size-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{row.file.name}</p>
          <p
            className={cn(
              'truncate text-xs',
              row.submitError !== null || status === 'failed'
                ? 'text-status-high'
                : 'text-muted-foreground',
            )}
          >
            {stateLabel}
            {etaSeconds != null && status === 'processing' && (
              <> · {t('batchEta', { seconds: Math.max(1, Math.round(etaSeconds)) })}</>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {(status === 'queued' || status === 'processing') && (
            <Button variant="ghost" size="sm" onClick={() => handleCancel(idx)}>
              {t('batchCancel')}
            </Button>
          )}
          {status === 'failed' && row.jobId && (
            <Button variant="outline" size="sm" onClick={() => handleRetry(idx)}>
              {t('batchRetry')}
            </Button>
          )}
          {isTerminal && (
            <Button variant="ghost" size="sm" onClick={() => handleRemove(idx)}>
              {t('batchRemove')}
            </Button>
          )}
        </div>
      </li>
    )
  }

  const submittedRows = rows.filter((r) => r.jobId !== null)
  const terminalCount = submittedRows.filter((r) => {
    const s = jobById.get(r.jobId!)?.status
    return s === 'done' || s === 'failed' || s === 'cancelled'
  }).length
  const activeCount = submittedRows.length - terminalCount
  const doneIds = submittedRows
    .filter((r) => jobById.get(r.jobId!)?.status === 'done')
    .map((r) => r.jobId!)
  // Completion state: every submitted row reached a terminal state and there
  // is at least one extracted document to review.
  const batchComplete =
    submittedRows.length > 0 &&
    activeCount === 0 &&
    rows.every((r) => r.jobId !== null) &&
    doneIds.length > 0
  const remainingNow = quota ? Math.max(0, quota.remaining - submittedCount) : null

  return (
    <div className="mx-auto max-w-3xl py-4" data-testid="batch-import-panel">
      <div className="mb-5 text-center">
        <h1 className="text-balance text-2xl font-bold text-foreground">
          {t('batchTitle', { count: files.length })}
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-pretty text-sm text-muted-foreground">
          {t('batchSubtitle')}
        </p>
        <p className="mx-auto mt-1 text-xs text-muted-foreground">{t('batchLeaveHint')}</p>
      </div>

      {quota?.isAnon && (
        <p
          className="mb-3 flex flex-wrap items-center justify-center gap-x-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground"
          data-testid="anon-quota-notice"
        >
          {t('batchQuotaAnon', { limit: quota.limit })}
          <Link
            href="/register"
            className="font-semibold text-primary underline underline-offset-2"
          >
            {t('batchRegisterToImport')}
          </Link>
        </p>
      )}

      {quotaError && (
        <p
          className="mb-3 flex items-start gap-2 rounded-lg border border-status-high/20 bg-status-high/5 px-3 py-2 text-xs text-status-high"
          data-testid="quota-error"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {t('batchSubmitFailed', { error: '' })}
        </p>
      )}

      <div className="mb-2 flex items-center justify-between px-1 text-xs text-muted-foreground">
        <span data-testid="batch-overall">
          {t('batchOverall', { done: terminalCount, total: submittedRows.length })}
        </span>
        {quota && (
          <span data-testid="quota-remaining">
            {t('batchRemaining', { count: remainingNow ?? 0, limit: quota.limit })}
          </span>
        )}
      </div>

      <ul className="space-y-2">{rows.map((row, idx) => rowView(row, idx))}</ul>

      {batchComplete && (
        <div
          className="mt-5 rounded-xl border border-primary/20 bg-primary/5 p-4 text-center"
          data-testid="batch-complete"
        >
          <p className="text-sm font-semibold text-foreground">
            {t('batchAllDone', { count: doneIds.length })}
          </p>
          <div className="mt-3 flex items-center justify-center gap-2">
            <Link href={`/review-import?job=${doneIds[0]}`}>
              <Button>{t('batchReviewNow')}</Button>
            </Link>
            <Link href="/imports">
              <Button variant="outline">{t('batchTrackImports')}</Button>
            </Link>
          </div>
        </div>
      )}

      <div className="mt-5 text-center">
        <Button variant="ghost" onClick={onBack}>
          {t('batchBack')}
        </Button>
      </div>
    </div>
  )
}
