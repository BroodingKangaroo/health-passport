'use client'

import { createContext, useContext } from 'react'

import { SharedTranslationLimitError } from '@/lib/share'
import type { FlowsheetResponse, TranslateLang } from '@/lib/types'

/**
 * Where the print flow gets its data and its translations.
 *
 * `PrintSetup` is the app's own setup screen, and the recipient now renders
 * it too (shared-view plan ST4, §4). The two callers reach completely
 * different back ends: the owner's is `/api/flowsheet` +
 * `/api/translate-biomarkers` (authed, persists into the record's own
 * dictionary), the recipient's is `/api/share/flowsheet` +
 * `/api/share/translate` (public, spends a per-link budget and writes
 * nothing). Injecting that difference instead of forking the component is
 * what keeps the two documents identical — the alternative was a copy that
 * drifts the first time anyone touches the layout.
 *
 * The owner's implementation lives in `print-source-owner.tsx` and is the
 * only place in this seam that imports `services/api`; the recipient's lives
 * in `components/share/share-print-source.ts` and imports the share service.
 * `print-setup.tsx` itself imports neither, which is what lets the public
 * tree reuse it without pulling the authed data layer in (the import-graph
 * test enforces that).
 */

export type PrintTranslationSource = 'translated' | 'cached' | 'fallback'

export interface PrintTranslatedName {
  name: string
  source: PrintTranslationSource
}

export interface PrintTranslateResult {
  names: Map<string, PrintTranslatedName>
  categories: Record<string, string>
  /**
   * AI runs left for this principal AFTER the call. `null`/absent means "not
   * metered" — the owner's own flow, where the app's usage limits apply
   * instead of a per-document budget.
   */
  remaining?: number | null
}

export interface PrintSource {
  fetchFlowsheet: (opts?: { signal?: AbortSignal }) => Promise<FlowsheetResponse>

  translate: (
    lang: TranslateLang,
    names: { id: string; name: string }[],
    opts?: { signal?: AbortSignal; categories?: string[] },
  ) => Promise<PrintTranslateResult>

  /**
   * Take the terms the reader accepted in the review dialog.
   *
   * The owner's implementation PERSISTS them into the record's own
   * dictionary and reports how many it saved (which is what the "saved for
   * future documents" toast is about). A recipient's applies them to this
   * document only and reports zero: nothing a stranger does may be written
   * into someone else's record, so there is nothing to congratulate them on.
   */
  commit?: (
    lang: TranslateLang,
    items: { id: string; name: string }[],
    /**
     * `complete: false` marks a run where the model fell back to the source
     * language for some terms. It only affects `cached()` below: an incomplete
     * run is NOT reusable, so pressing Generate again genuinely retries it.
     */
    opts?: { complete?: boolean },
  ) => Promise<{ saved: number }>

  /**
   * Whether this document already holds a COMPLETE translation for `lang`
   * from this session, so Generate can reuse it without another call (ST4
   * review, F3).
   *
   * It matters because a recipient's run persists nothing: the server cannot
   * know the names were already paid for, so without this short-circuit every
   * press of Generate for a language the reader already generated would spend
   * another run of the link's budget. `false`/absent — the owner's source —
   * means "no client-side fast path"; the server's own cached short-circuit
   * (names already persisted on the definitions) still applies unchanged.
   */
  cached?: (lang: TranslateLang) => boolean

  /** Where "Generate Document" goes once the terms are settled. */
  enterEditor: () => void
}

/**
 * The reader has spent the document's AI translation budget.
 *
 * Its own type, not a generic failure: this is a decision, not an error, and
 * the setup screen answers it with a message that says what to do instead of
 * the "translation failed, using English" toast. Only the share source can
 * throw it — the owner's flow is bounded by the app's usage limits, which
 * fail with their own localized message from the API.
 *
 * Defined in `lib/share.ts` (a module with no React and no authed imports) so
 * the share service can throw the same class the setup screen catches;
 * re-exported here so the print seam reads as one vocabulary.
 */
export { SharedTranslationLimitError as PrintTranslationLimitError }

const PrintSourceContext = createContext<PrintSource | null>(null)

export function PrintSourceProvider({
  source,
  children,
}: {
  source: PrintSource
  children: React.ReactNode
}) {
  return (
    <PrintSourceContext.Provider value={source}>
      {children}
    </PrintSourceContext.Provider>
  )
}

export function usePrintSource(): PrintSource {
  const ctx = useContext(PrintSourceContext)
  if (!ctx) {
    throw new Error('usePrintSource must be used within a PrintSourceProvider')
  }
  return ctx
}
