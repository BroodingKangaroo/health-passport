'use client'

import { useCallback, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Toaster } from 'sonner'

import { PrintSetup } from '@/components/health-passport/print-setup'
import { SharedPrintEditor } from '@/components/share/SharedPrintEditor'
import { createSharePrintSource } from '@/components/share/share-print-source'
import type { SharedFlowsheetState } from '@/components/share/use-shared-flowsheet'
import { Button } from '@/components/ui/button'
import { readShareGrant } from '@/lib/share-grant'
import { LeaveGuardProvider, useLeaveGuard } from '@/providers/leave-guard-provider'
import { PrintConfigProvider } from '@/providers/print-config-provider'
import { PrintSourceProvider } from '@/providers/print-source-provider'
import { fetchSharedFlowsheet } from '@/services/share'
import type { SharedFlowsheet, SharedPrintStage, SharedRecord } from '@/lib/share'
import type { TranslateLang } from '@/lib/types'

/**
 * The recipient's print flow: the app's own passport printer, applied to
 * someone else's record (shared-view plan §4).
 *
 * The whole module sits behind one lazy boundary in the shell, so a recipient
 * who never presses Print downloads none of it. Inside, both stages are the
 * app's own components:
 *
 * - **Setup** is `PrintSetup` — translation mode and target language, then
 *   the layout, text-size, column and biomarker filters. Its data and its
 *   translations come from a share-scoped `PrintSource` (see
 *   `share-print-source.ts`), which is why one screen serves both an owner
 *   and a stranger without a fork.
 * - **Editor** is `SharedPrintEditor`, the app's print editor over the share
 *   payload, ending in the browser's own print dialog.
 *
 * The two stages are URL state on the record's route (plan §1's rule that the
 * URL is the state), so a doctor can bookmark the document they configured
 * and open it again.
 */
export function SharedPrintFlow({
  token,
  record,
  locale,
  stage,
  onStage,
  onClose,
  flowsheetState,
}: {
  token: string
  record: SharedRecord
  locale: string
  stage: SharedPrintStage
  onStage: (stage: SharedPrintStage) => void
  onClose: () => void
  flowsheetState: SharedFlowsheetState
}) {
  const [namesByLang, setNamesByLang] = useState<
    Record<string, Record<string, string>>
  >({})
  // Which languages this session has already produced a COMPLETE document in
  // (ST4 review, F3). A run that fell back for some terms is recorded as
  // incomplete, so Generate still retries it instead of trapping the reader
  // with a half-translated document.
  const [completeByLang, setCompleteByLang] = useState<Record<string, boolean>>({})
  // The authoritative budget for this document, seeded from the record payload
  // and updated by every run that reports a new count. It lives here, not in
  // `PrintSetup`, because the setup screen remounts when the reader comes back
  // from the editor — and the record payload's number is as of page load.
  const [translationRemaining, setTranslationRemaining] = useState(
    record.meta.translation_remaining,
  )

  // The record's own table. The shell already fetched it (one fetch per page,
  // see useSharedFlowsheet); print reuses that payload rather than asking the
  // backend for it again, and falls back to a fetch only when the reader
  // arrived directly at `?print=editor`.
  const flowsheet = useCallback(async (): Promise<SharedFlowsheet> => {
    if (flowsheetState.flowsheet) return flowsheetState.flowsheet
    return (await fetchSharedFlowsheet(
      token,
      readShareGrant(token),
    )) as SharedFlowsheet
  }, [flowsheetState, token])

  const onTranslations = useCallback(
    (
      lang: TranslateLang,
      items: { id: string; name: string }[],
      opts?: { complete?: boolean },
    ) => {
      setNamesByLang((prev) => ({
        ...prev,
        [lang]: {
          ...(prev[lang] ?? {}),
          ...Object.fromEntries(items.map((item) => [item.id, item.name])),
        },
      }))
      // `undefined` counts as complete: a caller with nothing to report (the
      // fallback-free case) must not make every run look like a failure.
      setCompleteByLang((prev) => ({ ...prev, [lang]: opts?.complete !== false }))
    },
    [],
  )

  const enterEditor = useCallback(() => onStage('editor'), [onStage])
  const isCached = useCallback(
    (lang: TranslateLang) => completeByLang[lang] === true,
    [completeByLang],
  )

  const source = useMemo(
    () =>
      createSharePrintSource({
        token,
        locale,
        flowsheet,
        onTranslations,
        cached: isCached,
        enterEditor,
      }),
    [token, locale, flowsheet, onTranslations, isCached, enterEditor],
  )

  return (
    <LeaveGuardProvider>
      {/* `persist={false}`: nothing about a stranger's visit is written to
          storage. Setup and editor are two stages of one tree, so the
          in-memory copy survives the switch. */}
      <PrintConfigProvider persist={false}>
        <PrintSourceProvider source={source}>
          <PrintFlowBody
            record={record}
            stage={stage}
            onStage={onStage}
            onClose={onClose}
            flowsheetState={flowsheetState}
            namesByLang={namesByLang}
            translationRemaining={translationRemaining}
            onTranslationRemaining={setTranslationRemaining}
          />
          {/* The setup screen reports failures as toasts, and the recipient's
              page mounts no app shell — this is the only Toaster on it. */}
          <Toaster position="bottom-right" richColors />
        </PrintSourceProvider>
      </PrintConfigProvider>
    </LeaveGuardProvider>
  )
}

/**
 * The flow's chrome and stage switch, rendered INSIDE the providers: it needs
 * the leave guard the setup screen arms while a translation is in flight.
 */
function PrintFlowBody({
  record,
  stage,
  onStage,
  onClose,
  flowsheetState,
  namesByLang,
  translationRemaining,
  onTranslationRemaining,
}: {
  record: SharedRecord
  stage: SharedPrintStage
  onStage: (stage: SharedPrintStage) => void
  onClose: () => void
  flowsheetState: SharedFlowsheetState
  namesByLang: Record<string, Record<string, string>>
  translationRemaining: number
  onTranslationRemaining: (remaining: number) => void
}) {
  const t = useTranslations('sharedView')
  const { confirmLeave } = useLeaveGuard()

  async function backToRecord() {
    // A translation still running is cancelled by leaving, so ask first —
    // the same contract the owner's setup screen has.
    if (!(await confirmLeave())) return
    onClose()
  }

  if (stage === 'editor') {
    if (flowsheetState.status === 'error') {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-muted-foreground">{t('print.tableUnavailable')}</p>
            <Button variant="outline" size="sm" onClick={flowsheetState.retry}>
              {t('print.retry')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('print.backToRecord')}
            </Button>
          </div>
        </div>
      )
    }
    if (!flowsheetState.flowsheet) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <p className="text-sm text-muted-foreground">{t('print.loading')}</p>
        </div>
      )
    }
    return (
      <SharedPrintEditor
        record={record}
        flowsheet={flowsheetState.flowsheet}
        namesByLang={namesByLang}
        onBack={() => onStage('setup')}
      />
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border bg-card px-5 print:hidden">
        <div className="flex items-center py-2">
          <Button
            variant="ghost"
            onClick={() => void backToRecord()}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {t('print.backToRecord')}
          </Button>
        </div>
      </nav>
      <main className="p-5">
        <PrintSetup
          initialTranslationRemaining={translationRemaining}
          onTranslationRemaining={onTranslationRemaining}
          // Whose record, and for how long: the provenance exists inside the
          // generated document, but a reader configuring one should see it on
          // the setup screen (shared-view review, item 2).
          recordContext={{
            name: record.header?.name ?? null,
            expiresAt: record.meta.expires_at ?? null,
          }}
        />
      </main>
    </div>
  )
}
