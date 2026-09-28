'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Languages, FileOutput, ChevronDown, LoaderCircle } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import { useLeaveGuard } from '@/providers/leave-guard-provider'
import {
  PrintTranslationLimitError,
  usePrintSource,
} from '@/providers/print-source-provider'
import type { PrintLang, TranslateLang } from '@/lib/types'
import {
  TranslationPreviewDialog,
  TranslationFallbackWarning,
  type TranslationPreviewItem,
} from './translation-preview-dialog'

type Mode = 'original' | 'translate' | 'bilingual'

const TARGETS: { id: PrintLang }[] = [
  { id: 'en' },
  { id: 'de' },
  { id: 'fr' },
  { id: 'es' },
  { id: 'he' },
  { id: 'pl' },
]

const MODES: Mode[] = ['original', 'translate', 'bilingual']

export function PrintSetup({
  initialTranslationRemaining = null,
  onTranslationRemaining,
}: {
  /**
   * How many AI translation runs this document has left, shown BEFORE the
   * reader spends one (shared-view plan §5). `null` — the owner's own flow —
   * means "not metered here": the app's usage limits apply instead, and the
   * setup screen stays silent about them.
   */
  initialTranslationRemaining?: number | null
  /**
   * Reports the count a run came back with, so the caller can keep showing the
   * authoritative number when this component remounts (the recipient's setup
   * and editor are two stages of one tree, so going back to setup would
   * otherwise re-read the count from the record payload fetched at page load —
   * stale by exactly the runs already spent).
   */
  onTranslationRemaining?: (remaining: number) => void
} = {}) {
  const t = useTranslations('print.setup')
  const source = usePrintSource()
  const { mode, targetLanguage, setMode, setTargetLanguage, setCategoryTranslations, setSuppressSavedTranslations } =
    usePrintConfig()
  const { arm, disarm } = useLeaveGuard()
  const [translating, setTranslating] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [remaining, setRemaining] = useState<number | null>(initialTranslationRemaining)
  const [preview, setPreview] = useState<TranslationPreviewItem[] | null>(null)
  const [catPreview, setCatPreview] = useState<{ original: string; translated: string }[]>([])
  const [lastRun, setLastRun] = useState<{ cachedAll: boolean; failed: number } | null>(null)
  const translateAbortRef = useRef<AbortController | null>(null)

  // Live "Translating… Ns" counter so a 5–30 s AI call never feels stuck.
  useEffect(() => {
    if (!translating) return
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [translating])

  // Leaving the page mid-translation aborts the in-flight request so its
  // completion cannot hijack navigation back into /print-editor.
  useEffect(() => {
    return () => translateAbortRef.current?.abort()
  }, [])

  /** Programmatic exit into the editor. Tears the leave-guard down with
   * `{ pop: false }`: the marker's history.go(-1) delivers its popstate
   * ASYNC, landing inside the router.push() soft navigation that follows and
   * aborting it as "stale" — the user stays here ("the editor never opens").
   * The leftover marker is harmless: handlePop absorbs it silently on the
   * next Back press. (Both guard teardowns below are idempotent.) */
  function exitToEditor() {
    disarm({ pop: false })
    setTranslating(false)
    source.enterEditor()
  }

  async function handleGenerate() {
    if (mode === 'original' || targetLanguage === 'en') {
      source.enterEditor()
      return
    }
    // This document already holds a COMPLETE translation for this language
    // from earlier in this session: reuse it and spend nothing (ST4 review,
    // F3). A recipient's run persists nothing, so the server cannot tell that
    // the names were already paid for — without this, going back to the setup
    // screen and pressing Generate again for the same language would spend a
    // second run of the link's budget for an identical document.
    if (source.cached?.(targetLanguage as TranslateLang)) {
      source.enterEditor()
      return
    }
    // The document promises an AI translation: actually perform it before
    // navigating. Nothing is persisted here — the review dialog's confirm
    // step commits only the terms the user accepted.
    setLastRun(null)
    setPreview(null)
    setCatPreview([])
    setElapsed(0)
    const controller = new AbortController()
    translateAbortRef.current = controller
    // A new attempt supersedes any prior failure suppression, and clears a
    // sticky prior failure toast (if the user is retrying).
    setSuppressSavedTranslations(false)
    toast.dismiss()
    // Guard ONLY the in-flight network phase: once results are back, leaving
    // during review loses nothing (nothing is persisted until confirm).
    arm(t('leaveGuard'), () => controller.abort())
    setTranslating(true)
    try {
      const data = await source.fetchFlowsheet({ signal: controller.signal })
      const unique = new Map<string, string>()
      for (const cat of data.matrix) {
        for (const row of cat.rows) {
          const name = row.name.trim()
          // Never ask the LLM to translate an empty name (a def without an
          // English name) — it would hallucinate one.
          if (name) unique.set(row.id, name)
        }
      }
      const names = [...unique].map(([id, name]) => ({ id, name }))
      // Distinct non-empty category headings ride the same batch; the API is
      // keyed by their trimmed form, stored per RAW heading below.
      const categories = [
        ...new Set(data.matrix.map((c) => c.category.trim()).filter(Boolean)),
      ]
      if (names.length > 0 || categories.length > 0) {
        // The share dialog (Stage 3, S14) widened `TranslateLang` with 'ru';
        // the print flow must NEVER send 'ru' here — the document renders ru
        // from the source name natively, not through this endpoint. Keep
        // `TARGETS` (the only producer of this value) free of 'ru'.
        const results = await source.translate(
          targetLanguage as TranslateLang,
          names,
          { signal: controller.signal, categories },
        )
        if (typeof results.remaining === 'number') {
          setRemaining(results.remaining)
          onTranslationRemaining?.(results.remaining)
        }
        // The API is keyed by trimmed headings, but the editor looks matrix
        // categories up verbatim — store one entry per RAW heading so
        // whitespace variants still resolve.
        const stored: Record<string, string> = {}
        const headingPreview: { original: string; translated: string }[] = []
        const storedRaw = new Set<string>()
        for (const cat of data.matrix) {
          const raw = cat.category
          const translated = results.categories[raw.trim()]
          if (!raw.trim() || !translated || storedRaw.has(raw)) continue
          storedRaw.add(raw)
          stored[raw] = translated
          headingPreview.push({ original: raw, translated })
        }
        if (Object.keys(stored).length > 0) {
          setCategoryTranslations(stored)
        }
        setCatPreview(headingPreview)
        const items: TranslationPreviewItem[] = names.map(({ id, name }) => {
          const entry = results.names.get(id)
          return {
            id,
            english: name,
            translated: entry?.name ?? name,
            source: entry?.source ?? 'fallback',
          }
        })
        const failed = items.filter((i) => i.source === 'fallback').length
        const cachedAll = items.every((i) => i.source === 'cached')
        setLastRun({ cachedAll, failed })
        if (cachedAll) {
          // Re-generate of an already-translated document: nothing new to
          // review, and this path is instant and free.
          exitToEditor()
          return
        }
        // Review step: surface the terms before they land in the document.
        setPreview(items)
      } else {
        exitToEditor()
      }
    } catch (err) {
      // The user confirmed leave mid-translation: stay silent — no toast,
      // no navigation. The leave has already happened.
      if (controller.signal.aborted) return
      // A spent budget is a decision, not a failure: the reader stays here
      // and is told what to do about it. Navigating to an English document
      // would look like a translation bug (ST4, §5).
      if (err instanceof PrintTranslationLimitError) {
        setRemaining(0)
        onTranslationRemaining?.(0)
        return
      }
      // Best-effort translation: never block the export. Force the editor to
      // render the English / source document for this run so the fallback
      // contract actually holds (saved translations would otherwise still
      // show), and pin a dismissible toast so the user can always see what
      // happened — even if they already switched tabs.
      setSuppressSavedTranslations(true)
      const reason = err instanceof Error ? err.message : 'unknown error'
      toast.error(
        t('toastFailed', { reason }),
        { duration: Infinity, closeButton: true },
      )
      exitToEditor()
    } finally {
      disarm()
      if (!controller.signal.aborted) setTranslating(false)
    }
  }

  /** Persist the accepted terms, then enter the editor. Called by the review
   * dialog's confirm button; Back/closing the dialog discards instead. */
  async function handleConfirmPreview(accepted: TranslationPreviewItem[]) {
    setPreview(null)
    if (accepted.length > 0) {
      try {
        // Same trap as the translate call above: 'ru' must never reach the
        // commit endpoint from the print flow (render ru from the source).
        const { saved } = (await source.commit?.(
          targetLanguage as TranslateLang,
          accepted.map((i) => ({ id: i.id, name: i.translated })),
          // A run that fell back for some terms is not reusable, so a retry
          // still reaches the model (see `PrintSource.cached`).
          { complete: (lastRun?.failed ?? 0) === 0 },
        )) ?? { saved: 0 }
        // Zero saved is the recipient's case: the terms are applied to THIS
        // document, and there is no future document to promise. The toast
        // would otherwise tell a stranger their translations were stored in
        // someone else's record.
        if (saved > 0) toast.success(t('toastSaved', { count: saved }))
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error'
        toast.error(t('toastSaveFailed', { reason }))
      }
    }
    source.enterEditor()
  }

  const target = TARGETS.find((x) => x.id === targetLanguage)
  const languageLabel = target ? t(`targetLangs.${target.id}`) : targetLanguage

  return (
    <div className="mx-auto mt-12 max-w-xl px-5">
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <FileOutput className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">
                {t('title')}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t('subtitle')}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 px-6 py-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('translationMode')}
          </p>
          {MODES.map((m) => {
            const selected = mode === m
            return (
              <label
                key={m}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors',
                  selected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent',
                )}
              >
                <input
                  type="radio"
                  name="mode"
                  checked={selected}
                  onChange={() => setMode(m)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {t(`modes.${m}.title`)}
                    </span>
                    {m !== 'original' && selected && (
                      <div className="relative inline-flex">
                        <select
                          value={targetLanguage}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            setTargetLanguage(e.target.value as PrintLang)
                            setMode(m)
                          }}
                          className="appearance-none rounded-md border border-border bg-background py-1 pl-2.5 pr-7 text-xs font-medium text-foreground outline-none focus:border-primary"
                        >
                          {TARGETS.map((tg) => (
                            <option key={tg.id} value={tg.id}>
                              {t(`targetLangs.${tg.id}`)}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t(`modes.${m}.desc`)}
                  </p>
                </div>
              </label>
            )
          })}
        </div>

        <div className="border-t border-border px-6 py-4">
          {/* The budget, stated before it is spent (shared-view plan §5). It
              renders only when the document is metered — the owner's own
              print flow has the app's usage limits behind it, not a
              per-document allowance. */}
          {remaining !== null && mode !== 'original' && targetLanguage !== 'en' && (
            <p
              data-testid="print-translation-budget"
              role={remaining === 0 ? 'alert' : undefined}
              className={cn(
                'mb-3 text-xs',
                remaining > 0 ? 'text-muted-foreground' : 'text-amber-600',
              )}
            >
              {remaining > 0
                ? t('budgetRemaining', { count: remaining })
                : t('budgetExhausted')}
            </p>
          )}
          {!translating && lastRun && !preview && (
            <div className="mb-3 space-y-1">
              {lastRun.cachedAll && (
                <p className="text-xs text-muted-foreground">
                  {t('cachedNotice')}
                </p>
              )}
              <TranslationFallbackWarning count={lastRun.failed} />
            </div>
          )}
          <Button className="h-11 w-full text-sm" onClick={handleGenerate} disabled={translating}>
            {translating ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {t('translating', { elapsed })}
              </>
            ) : (
              <>
                <Languages className="size-4" />
                {t('generate')}
              </>
            )}
          </Button>
        </div>
      </div>

      {preview && (
        <TranslationPreviewDialog
          items={preview}
          categories={catPreview}
          languageLabel={languageLabel}
          onConfirm={handleConfirmPreview}
          onCancel={() => setPreview(null)}
        />
      )}
    </div>
  )
}
