'use client'

import { useId, useState } from 'react'
import { CheckCircle2, AlertTriangle, Languages, ArrowRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import type { TranslationSource } from '@/services/api'

export interface TranslationPreviewItem {
  id: string
  english: string
  translated: string
  source: TranslationSource
}

const CACHED_BADGE_CLASS = 'border-border bg-muted text-muted-foreground'

const FALLBACK_BADGE_CLASS =
  'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400'

const KEPT_AS_IS_BADGE_CLASS =
  'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-400'

/**
 * Resolve the badge shown next to the translated name. Fallback rows have no
 * badge here — their "English fallback" label renders in the choice column
 * instead (there is no toggle to show: no translation exists).
 */
function badgeFor(
  item: TranslationPreviewItem,
  t: ReturnType<typeof useTranslations>,
): {
  label: string
  className: string
  title?: string
} | null {
  if (item.source === 'fallback') return null
  if (item.source === 'cached') {
    return { label: t('badges.cached'), className: CACHED_BADGE_CLASS }
  }
  if (item.source === 'translated' && item.translated === item.english) {
    return {
      label: t('badges.keptAsIs'),
      className: KEPT_AS_IS_BADGE_CLASS,
      title: t('keptAsIsTooltip'),
    }
  }
  return null
}

/**
 * Rows whose name cannot be chosen: `cached` already has a persisted
 * translation (toggle locked to Translation), a kept-as-is translation is
 * fixed by definition (same), and `fallback` has no translation at all —
 * those rows show the "English fallback" label in the choice column instead
 * of a toggle. Only fresh translations are decidable (null).
 */
function fixedChoiceFor(item: TranslationPreviewItem): 'translation' | 'english' | null {
  if (item.source === 'translated') return null
  if (item.source === 'fallback') return 'english'
  return 'translation'
}

/**
 * Review step between translation and document generation: shows each English
 * name next to its AI translation with a per-term Translation/English choice
 * (only fresh translations are decidable — every other row renders the same
 * toggle locked to its forced outcome). Confirming hands the ACCEPTED terms
 * to `onConfirm` so they get persisted for future documents; going back
 * discards everything from this run.
 *
 * `categories` (panel headings) are informational only — they are structural
 * groupings rather than patient-facing terms, are never persisted, and are
 * always applied to this document.
 */
export function TranslationPreviewDialog({
  items,
  categories = [],
  languageLabel,
  onConfirm,
  onCancel,
}: {
  items: TranslationPreviewItem[]
  /** Panel heading translations shown read-only (always applied). */
  categories?: { original: string; translated: string }[]
  languageLabel: string
  /** Receives only the accepted, newly translated terms. */
  onConfirm: (accepted: TranslationPreviewItem[]) => void
  onCancel: () => void
}) {
  const t = useTranslations('print.review')
  // Accept-by-default: proceeding without touching anything saves every term,
  // matching the previous all-or-nothing behavior.
  const [rejected, setRejected] = useState<Record<string, boolean>>({})
  const titleId = useId()

  if (items.length === 0) return null

  const decidable = items.filter((i) => i.source === 'translated')
  const accepted = decidable.filter((i) => !rejected[i.id])
  const hasKeptAsIs = items.some(
    (i) => i.source === 'translated' && i.translated === i.english,
  )
  const hasFallback = items.some((i) => i.source === 'fallback')

  return (
    <ModalDialog
      open
      onClose={onCancel}
      closeOnBackdrop
      labelledBy={titleId}
      panelClassName="max-h-[85vh] w-full max-w-3xl flex flex-col rounded-xl bg-background p-6 shadow-xl"
    >
      <div className="mb-4 flex shrink-0 items-start gap-3">
        <Languages className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('intro', { languageLabel })}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* One shared grid template for header AND rows (fixed px for the
            arrow/toggle tracks) so every column aligns across rows — with
            per-row `1fr` grids, rows without a toggle computed different
            widths and the columns drifted. The header row sticks inside this
            scroll region so columns stay labelled on long lists. */}
        <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1.4fr)_148px] items-center gap-x-3 bg-background px-4 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>{t('biomarker')}</span>
          <span />
          <span>{t('nameInDocument')}</span>
          <span />
        </div>
        <div className="rounded-lg border border-border">
          {items.map((item) => {
            const badge = badgeFor(item, t)
            const fixedChoice = fixedChoiceFor(item)
            const isDecidable = fixedChoice === null
            const useEnglish = isDecidable ? !!rejected[item.id] : fixedChoice === 'english'
            return (
              <div
                key={item.id}
                className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1.4fr)_148px] items-center gap-x-3 border-b border-border px-4 py-2.5 last:border-b-0"
              >
                <span
                  title={item.english}
                  className="min-w-0 truncate text-sm text-muted-foreground"
                >
                  {item.english}
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground/60" />
                <span className="flex min-w-0 items-center gap-2">
                  {/* Preview of the name that will actually appear in the
                      document — the toggle decides which one. */}
                  <span
                    title={useEnglish ? item.english : item.translated}
                    className={cn(
                      'min-w-0 truncate text-sm font-medium',
                      useEnglish ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {useEnglish ? item.english : item.translated}
                  </span>
                  {badge && (
                    <span
                      title={badge.title}
                      className={cn(
                        'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                        badge.className,
                      )}
                    >
                      {badge.label}
                    </span>
                  )}
                </span>
                {item.source === 'fallback' ? (
                  // No translation exists to choose: the amber label takes
                  // the toggle's place at the right edge.
                  <span
                    title={t('fallbackTooltip')}
                    className={cn(
                      'shrink-0 justify-self-end rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                      FALLBACK_BADGE_CLASS,
                    )}
                  >
                    {t('badges.fallback')}
                  </span>
                ) : (
                  <div
                    role="radiogroup"
                    aria-label={t('radioName', { name: item.english })}
                    className="flex shrink-0 justify-self-end overflow-hidden rounded-md border border-border text-[11px] font-medium"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!useEnglish}
                      aria-label={t('radioTranslation', { name: item.english })}
                      disabled={!isDecidable}
                      onClick={() => setRejected((p) => ({ ...p, [item.id]: false }))}
                      className={cn(
                        'px-2 py-1 transition-colors',
                        !useEnglish
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-accent',
                        !isDecidable && 'cursor-not-allowed hover:bg-transparent',
                      )}
                    >
                      {t('translation')}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!!useEnglish}
                      aria-label={t('radioEnglish', { name: item.english })}
                      disabled={!isDecidable}
                      onClick={() => setRejected((p) => ({ ...p, [item.id]: true }))}
                      className={cn(
                        'px-2 py-1 transition-colors',
                        useEnglish
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-accent',
                        !isDecidable && 'cursor-not-allowed hover:bg-transparent',
                      )}
                    >
                      {t('english')}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {categories.length > 0 && (
          <div className="mt-3 rounded-lg border border-border px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('panelHeadings')}
            </p>
            <div className="mt-2 space-y-2">
              {categories.map((c) => (
                <div
                  key={c.original}
                  className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1.4fr)] items-center gap-x-3"
                >
                  <span
                    title={c.original}
                    className="min-w-0 truncate text-sm text-muted-foreground"
                  >
                    {c.original}
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground/60" />
                  <span title={c.translated} className="min-w-0 truncate text-sm font-medium">
                    {c.translated}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(hasKeptAsIs || hasFallback) && (
          <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            {hasKeptAsIs && (
              <p>
                <span className="font-medium text-sky-700 dark:text-sky-400">{t('badges.keptAsIs')}</span>
                {' '}
                {t('legendKeptAsIs')}
              </p>
            )}
            {hasFallback && (
              <p>
                <span className="font-medium text-amber-700 dark:text-amber-400">{t('badges.fallback')}</span>
                {' '}
                {t('legendFallback')}
              </p>
            )}
          </div>
        )}

        <p className="mt-2 text-xs text-muted-foreground">
          {t('choiceNote')}
        </p>
      </div>

      <div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onCancel}>
            {t('back')}
          </Button>
          <Button onClick={() => onConfirm(accepted)} className="gap-1.5">
            <CheckCircle2 className="size-4" />
            {accepted.length > 0
              ? t('saveAndGenerate', { count: accepted.length })
              : t('generateNothingSaved')}
          </Button>
      </div>
    </ModalDialog>
  )
}

export function TranslationFallbackWarning({ count }: { count: number }) {
  const t = useTranslations('print.review')
  if (count === 0) return null
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-600">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      {t('fallbackWarning', { count })}
    </p>
  )
}
