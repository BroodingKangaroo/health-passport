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
import { BackNav } from '@/components/shared/BackNav'
import { markImportJobSeen } from '@/lib/new-import-jobs'
import { useAuthPrincipal } from '@/lib/hooks/useAuthPrincipal'
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
 * exactly as they do from the SSE result). Save, Dismiss and "Leave for
 * later" all return to /imports: Save consumes the staged job server-side
 * (entry + attachment created, job kept as a history row), Leave keeps it
 * staged (stays in the bell + tracker), Dismiss abandons it via DELETE
 * (job kept as `dismissed`, revivable via the tracker's Restore within the
 * GC TTL, bell notification deleted). A failed/expired/already-saved job →
 * honest error + dismiss. All actions live in ONE footer — the AddEntry
 * card's footerActions slot (there is no separate Cancel: it duplicated
 * "Leave for later").
 */
export function ReviewImport() {
  const t = useTranslations('import')
  const router = useRouter()
  const queryClient = useQueryClient()
  const searchParams = useSearchParams()
  const jobId = searchParams.get('job')
  const { authReady } = useAuthPrincipal()

  // The staged document for the preview pane (best-effort — a failed fetch
  // leaves the preview empty but never blocks the review).
  const [stagedFile, setStagedFile] = useState<File | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  // GATED on session readiness: on a hard reload/deep-link the mount fires
  // before next-auth resolves the bearer token — a tokenless fetch would 404
  // (the job belongs to the user's tenant, the anon principal sees nothing)
  // and `retry: false` would park the page in the permanent "gone" state.
  const { data: detail, isPending, isError } = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => fetchImportJob(jobId!),
    enabled: !!jobId && authReady,
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
    // Opening the review editor counts as viewing the job — it loses the
    // tracker's New badge (covers bell deep-links too).
    markImportJobSeen(detail.id)
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
      .catch((e) => {
        if (cancelled) return
        console.error('Staged file preview failed', e)
        setPreviewFailed(true)
      })
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

  // Abandon the staged document from the review page: the job lands in the
  // tracker's history as `dismissed` (same immediate semantics as the
  // tracker's dismiss — bell notification deleted server-side; a done job's
  // staged file + result are kept so the tracker's Restore can revive it
  // within the GC TTL). A failed dismiss still navigates away — the job is
  // gone (swept/expired) or already saved/consumed either way.
  async function handleDismiss() {
    if (!detail || dismissing) return
    setDismissing(true)
    try {
      await dismissImportJob(detail.id)
      toast.success(t('reviewDismissToast'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('reviewLoadFailed'))
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['import-jobs'] })
      await queryClient.invalidateQueries({ queryKey: ['notifications'] })
      setDismissing(false)
      router.push('/imports')
    }
  }

  return (
    <div className="min-h-screen bg-background" data-testid="review-import-view">
      <HeaderBar />
      <BackNav label={t('trackerTitle')} onBack={handleLeaveForLater} />
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
                  await queryClient.invalidateQueries({ queryKey: ['notifications'] })
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
            {previewFailed && (
              <p className="mx-auto mb-3 max-w-3xl rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400">
                {t('reviewPreviewFailed')}
              </p>
            )}
            <AddEntry
              onSave={handleSave}
              onCancel={handleLeaveForLater}
              stagedJob={{ jobId: detail.id, record: detail.result!, file: stagedFile }}
              footerActions={
                <>
                  <Button
                    variant="ghost"
                    onClick={() => void handleDismiss()}
                    disabled={dismissing}
                    data-testid="review-dismiss"
                    className="hover:bg-destructive/10 hover:text-destructive"
                  >
                    {t('trackerDismiss')}
                  </Button>
                  <Button variant="ghost" onClick={handleLeaveForLater}>
                    {t('reviewLeaveForLater')}
                  </Button>
                </>
              }
            />
          </main>
        </>
      )}
    </div>
  )
}
