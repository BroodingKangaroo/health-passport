'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertCircle, ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { HeaderBar } from './header-bar'
import { AddEntry } from './add-entry'
import {
  dismissImportJob,
  fetchImportJob,
  fetchImportJobFile,
} from '@/services/import-jobs'

/**
 * Review page for a staged batch-import job (/review-import?job=<id>).
 *
 * Fetches the staged StandardizedMedicalRecord and prefills the EXISTING
 * add-entry editor machinery (same fill path, unit-conflict dialog, merge
 * checkbox, document-type editors — all derive from the staged record
 * exactly as they do from the SSE result). Save and Cancel both return to
 * /imports: Save consumes the staged job server-side (entry + attachment
 * created, job kept as a history row), Cancel leaves it staged (stays in
 * the bell + tracker). A failed/expired/already-saved job → honest error +
 * dismiss.
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

  // Save consumed the staged job server-side — return to the tracker where
  // the saved import now appears in the history section.
  const handleSave = useCallback(async () => {
    toast.success(t('reviewSavedToast'))
    await queryClient.invalidateQueries({ queryKey: ['import-jobs'] })
    await queryClient.invalidateQueries({ queryKey: ['notifications'] })
    router.push('/imports')
  }, [t, queryClient, router])

  function handleLeaveForLater() {
    // Job stays staged — it remains in the bell and the tracker.
    router.push('/imports')
  }

  return (
    <div className="min-h-screen bg-background" data-testid="review-import-view">
      <HeaderBar />
      <nav className="border-b border-border bg-card px-5 print:hidden">
        <div className="flex items-center py-2">
          <Button
            variant="ghost"
            onClick={handleLeaveForLater}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {t('trackerTitle')}
          </Button>
        </div>
      </nav>
      {state === 'loading' ? (
        <div className="mx-auto max-w-md py-16 text-center text-sm text-muted-foreground">
          {t('reviewLoading')}
        </div>
      ) : state === 'processing' ? (
        <div
          className="mx-auto max-w-md py-16 text-center"
          data-testid="review-still-processing"
        >
          <p className="text-sm text-muted-foreground">{t('trackerQueued')}</p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push('/imports')}
          >
            {t('bellViewAll')}
          </Button>
        </div>
      ) : state === 'gone' || !detail || detail.status !== 'done' ? (
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
                router.push('/imports')
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
      ) : (
        <>
          <main className="p-5">
            <AddEntry
              onSave={handleSave}
              onCancel={handleLeaveForLater}
              stagedJob={{ jobId: detail.id, record: detail.result!, file: stagedFile }}
            />
          </main>
          <div className="mx-auto flex max-w-[1600px] justify-end px-6 pb-6">
            <Button variant="ghost" onClick={handleLeaveForLater}>
              {t('reviewLeaveForLater')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
