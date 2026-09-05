'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertCircle, ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { AddEntry } from './add-entry'
import {
  dismissImportJob,
  fetchImportJob,
  fetchImportJobFile,
  fetchImportJobs,
} from '@/services/import-jobs'

/**
 * Review page for a staged batch-import job (/review-import?job=<id>).
 *
 * Fetches the staged StandardizedMedicalRecord and prefills the EXISTING
 * add-entry editor machinery (same fill path, unit-conflict dialog, merge
 * checkbox, document-type editors — all derive from the staged record
 * exactly as they do from the SSE result). Save → POST /api/entry (or
 * /merge) with import_job_id — no file re-upload — then auto-advance to the
 * next done job (if any). "Leave for later" → back; the job stays in the
 * bell. A failed/expired/saved job → honest error + dismiss.
 */
export function ReviewImport() {
  const t = useTranslations('import')
  const router = useRouter()
  const queryClient = useQueryClient()
  const searchParams = useSearchParams()
  const jobId = searchParams.get('job')

  // The staged document for the preview pane (best-effort — a failed fetch
  // leaves the preview empty but never blocks the review).
  const [stagedFile, setStagedFile] = useState<File | null>(null)
  const { data: detail, isPending, isError } = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => fetchImportJob(jobId!),
    enabled: !!jobId,
    retry: false,
  })

  // Fully derived from the query — no state-in-effect anywhere.
  const state: 'loading' | 'ready' | 'gone' | 'processing' = !jobId
    ? 'gone'
    : isPending || (!detail && !isError)
      ? 'loading'
      : detail
        ? detail.status === 'done' && detail.result
          ? 'ready'
          : detail.status === 'queued' || detail.status === 'processing'
            ? 'processing'
            : 'gone'
        : 'gone'

  useEffect(() => {
    if (!detail || detail.status !== 'done' || !detail.result) return
    let cancelled = false
    fetchImportJobFile(detail.id)
      .then((blob) => {
        if (cancelled) return
        setStagedFile(
          new File([blob], detail.original_filename || 'document', {
            type: blob.type || 'application/octet-stream',
          }),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [detail])

  const handleSave = useCallback(async () => {
    toast.success(t('reviewSavedToast'))
    // The job was consumed server-side; refresh the shared tracker cache.
    await queryClient.invalidateQueries({ queryKey: ['import-jobs'] })
    await queryClient.invalidateQueries({ queryKey: ['notifications'] })
    // Auto-advance to the next done job, if any; otherwise back home.
    let next: { id: string } | undefined
    try {
      const jobs = await fetchImportJobs()
      next = jobs.items.find((j) => j.status === 'done')
    } catch {
      /* advancing is best-effort — fall back to the timeline */
    }
    if (next) router.replace(`/review-import?job=${next.id}`)
    else router.push('/')
  }, [t, queryClient, router])

  function handleLeaveForLater() {
    // Job stays staged — it remains in the bell and the tracker.
    router.push('/')
  }

  if (state === 'loading') {
    return (
      <div className="mx-auto max-w-md py-16 text-center text-sm text-muted-foreground">
        {t('reviewLoading')}
      </div>
    )
  }

  if (state === 'processing') {
    return (
      <div className="mx-auto max-w-md py-16 text-center" data-testid="review-still-processing">
        <p className="text-sm text-muted-foreground">{t('trackerQueued')}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/imports')}>
          {t('bellViewAll')}
        </Button>
      </div>
    )
  }

  if (state === 'gone' || !detail || detail.status !== 'done') {
    return (
      <div className="mx-auto max-w-md py-16 text-center" data-testid="review-gone">
        <AlertCircle className="mx-auto size-8 text-status-high" />
        <p className="mt-3 text-sm text-muted-foreground">{t('reviewGone')}</p>
        {detail && (detail.status === 'failed' || detail.status === 'cancelled') && (
          <Button
            variant="outline"
            className="mt-4"
            onClick={async () => {
              try {
                await dismissImportJob(detail.id)
                await queryClient.invalidateQueries({ queryKey: ['import-jobs'] })
              } catch {
                /* already gone */
              }
              router.push('/')
            }}
          >
            {t('trackerDismiss')}
          </Button>
        )}
        <div className="mt-4">
          <Button variant="ghost" onClick={handleLeaveForLater}>
            <ArrowLeft className="size-4" />
            {t('reviewBack')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background" data-testid="review-import-view">
      <AddEntry
        onSave={handleSave}
        stagedJob={{ jobId: detail.id, record: detail.result!, file: stagedFile }}
      />
      <div className="mx-auto flex max-w-[1600px] justify-end px-6 pb-6">
        <Button variant="ghost" onClick={handleLeaveForLater}>
          {t('reviewLeaveForLater')}
        </Button>
      </div>
    </div>
  )
}
