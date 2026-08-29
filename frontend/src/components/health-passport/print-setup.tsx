'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Languages, FileOutput, ChevronDown, LoaderCircle } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import { useLeaveGuard } from '@/providers/leave-guard-provider'
import {
  fetchFlowsheetData,
  translateBiomarkerNames,
  commitTranslatedNames,
} from '@/services/api'
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

export function PrintSetup() {
  const t = useTranslations('print.setup')
  const router = useRouter()
  const { mode, targetLanguage, setMode, setTargetLanguage, setCategoryTranslations, setSuppressSavedTranslations } =
    usePrintConfig()
  const { arm, disarm } = useLeaveGuard()
  const [translating, setTranslating] = useState(false)
  const [elapsed, setElapsed] = useState(0)
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
    router.push('/print-editor')
  }

  async function handleGenerate() {
    if (mode === 'original' || targetLanguage === 'en') {
      router.push('/print-editor')
      return
    }
    // The document promises an AI translation: actually perform it before
    // navigating. The backend persists names[lang] on the definitions, so
    // repeated generates of an already-translated document are free.
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
      const data = await fetchFlowsheetData({ signal: controller.signal })
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
        const results = await translateBiomarkerNames(
          targetLanguage as TranslateLang,
          names,
          { persist: false, signal: controller.signal, categories },
        )
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
        await commitTranslatedNames(
          targetLanguage as TranslateLang,
          accepted.map((i) => ({ id: i.id, name: i.translated })),
        )
        toast.success(t('toastSaved', { count: accepted.length }))
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error'
        toast.error(t('toastSaveFailed', { reason }))
      }
    }
    router.push('/print-editor')
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
