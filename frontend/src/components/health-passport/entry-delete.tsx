'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { deleteEntry } from '@/services/api'
import type { MedicalEvent } from '@/lib/types'

/**
 * The entry settings tab's danger zone.
 *
 * This is the ONLY part of the entry detail views that talks to the write API
 * (`deleteEntry`) and to react-query, so it lives in its own module and is
 * imported DYNAMICALLY by `entry-settings.tsx`. Two things fall out of that:
 *
 * - The delete call and `services/api` are absent from the shared (recipient)
 *   component graph, which the import-graph test enforces. A recipient's
 *   bundle never contains a write path that assumes a session.
 * - `useQueryClient()` throws without a `QueryClientProvider`, and the shared
 *   tree deliberately has none — separating the module means the hook is only
 *   ever called under the providers that can serve it.
 */
export function EntryDelete({
  event,
  typeLabel,
  onDeleted,
}: {
  event: MedicalEvent
  typeLabel: string
  onDeleted: () => void
}) {
  const t = useTranslations('timeline.entrySettings')
  const tc = useTranslations('common')
  const queryClient = useQueryClient()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)
    try {
      await deleteEntry(event.id)
      // Invalidate cached server state so the deletion is reflected
      // everywhere immediately (the flowsheet caches for 5 min, so
      // invalidating only ['timeline'] would serve the deleted entry).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timeline'] }),
        queryClient.invalidateQueries({ queryKey: ['flowsheet'] }),
        queryClient.invalidateQueries({ queryKey: ['biomarker-definitions'] }),
      ])
      setConfirmOpen(false)
      onDeleted()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('deleteFailed')
      setError(msg)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="rounded-xl border border-status-high/30 bg-status-high/5 p-6">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="size-4 text-status-high" />
        <h3 className="text-sm font-semibold text-status-high">{t('dangerZone')}</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{t('dangerWarning')}</p>
      <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
        <PopoverTrigger asChild>
          <Button variant="destructive" disabled={deleting}>
            <Trash2 className="size-4" />
            {t('deleteEntry')}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-80"
          data-testid="delete-confirm"
        >
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {t('deleteConfirmTitle', { type: typeLabel.toLowerCase() })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{event.title}</p>
            </div>
            <p className="text-xs text-muted-foreground">{t('deleteConfirmBody')}</p>
            {error && (
              <p className="rounded-md border border-status-high/30 bg-status-high/10 px-2 py-1 text-xs text-status-high">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
              >
                {tc('cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
                data-testid="delete-confirm-button"
              >
                {deleting ? t('deleting') : tc('delete')}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
