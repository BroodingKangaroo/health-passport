'use client'

import {
  commitTranslatedNames,
  fetchFlowsheetData,
  translateBiomarkerNames,
} from '@/services/api'
import type { PrintSource } from '@/providers/print-source-provider'

/**
 * The owner's print source: the authed endpoints that back `/print-setup`.
 *
 * This module exists so `print-setup.tsx` itself never imports
 * `services/api` — the shared (recipient) tree renders the same setup screen,
 * and an authed import anywhere in its import graph would fail the
 * `shared-surface-imports` test (and, worse, risk pulling a bearer-token
 * module into a stranger's bundle).
 *
 * The call shape is exactly what the setup screen did inline before ST4:
 * `persist: false` on the translate call, with the accepted terms committed
 * separately by the review dialog's confirm step.
 */
export function createOwnerPrintSource(enterEditor: () => void): PrintSource {
  return {
    fetchFlowsheet: (opts) => fetchFlowsheetData(opts),
    translate: (lang, names, opts) =>
      translateBiomarkerNames(lang, names, {
        persist: false,
        signal: opts?.signal,
        categories: opts?.categories,
      }),
    commit: async (lang, items) => ({
      saved: await commitTranslatedNames(lang, items),
    }),
    enterEditor,
  }
}
