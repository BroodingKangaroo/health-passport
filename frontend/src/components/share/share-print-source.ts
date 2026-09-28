import { readShareGrant } from '@/lib/share-grant'
import { translateSharedRecord } from '@/services/share'
import type { PrintSource } from '@/providers/print-source-provider'
import type { FlowsheetResponse, TranslateLang } from '@/lib/types'

/**
 * The recipient's print source: the public endpoints that back the same
 * print-setup screen the owner uses.
 *
 * Two differences from the owner's source carry the whole safety story:
 *
 * - **Translations are bounded and never written.** The request carries the
 *   target language and nothing else — the names come from the link's own
 *   record, server-side — and the run is charged to the link's budget rather
 *   than to the owner's quota or an anonymous session (shared-view plan §5).
 * - **Accepted terms are kept in memory for this document only.** The owner's
 *   `commit` persists into the record's dictionary; a recipient's has nowhere
 *   to write, so it hands the terms back to the flow, which merges them into
 *   the document it is about to render. `saved: 0` is what stops the setup
 *   screen promising a stranger their terms are "saved for future documents".
 */
export function createSharePrintSource(opts: {
  token: string
  /** The reader's chosen UI language, sent so a refusal is localized. */
  locale: string
  /** The record's own table, reused from the shell so print does not refetch it. */
  flowsheet: () => Promise<FlowsheetResponse>
  onTranslations: (
    lang: TranslateLang,
    items: { id: string; name: string }[],
    opts?: { complete?: boolean },
  ) => void
  /**
   * Whether the flow already holds a complete translation for this language
   * (ST4 review, F3). Supplied by the flow, which owns that state; a language
   * whose run fell back for some terms is deliberately NOT reported as cached,
   * so a retry still reaches the model.
   */
  cached?: (lang: TranslateLang) => boolean
  enterEditor: () => void
}): PrintSource {
  return {
    fetchFlowsheet: () => opts.flowsheet(),
    translate: async (lang, _names, o) => {
      const result = await translateSharedRecord(opts.token, lang, {
        grant: readShareGrant(opts.token),
        locale: opts.locale,
        signal: o?.signal,
      })
      return {
        names: new Map(
          result.translations.map((item) => [
            item.id,
            { name: item.name, source: item.source },
          ]),
        ),
        // The editor looks a heading up by the EXACT string the matrix
        // carries, so the map is keyed by the server's `original` (the raw
        // heading), not by its cleaned form.
        categories: Object.fromEntries(
          result.categories.map((item) => [item.original, item.translated]),
        ),
        remaining: result.remaining,
      }
    },
    commit: async (lang, items, commitOpts) => {
      opts.onTranslations(lang, items, commitOpts)
      return { saved: 0 }
    },
    cached: (lang) => opts.cached?.(lang) ?? false,
    enterEditor: opts.enterEditor,
  }
}
