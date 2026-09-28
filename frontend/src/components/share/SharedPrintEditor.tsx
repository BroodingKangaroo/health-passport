'use client'

import { useEffect, useMemo } from 'react'

import { PrintEditor } from '@/components/health-passport/print-editor'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import { dateId } from '@/lib/print-document'
import type { SharedFlowsheet, SharedRecord } from '@/lib/share'
import type { BiomarkerResult, PrintLang } from '@/lib/types'

/**
 * The recipient's printed document: the app's own print editor over the
 * shared record.
 *
 * The editor is reused unchanged — same layout controls, same column and
 * biomarker filters, same browser print — so the sheet a doctor produces is
 * the same sheet the record's owner would produce. The container supplies the
 * three things that differ for a recipient:
 *
 * - **The data.** The share payload, already narrowed to the link's scope, so
 *   no `/api/flowsheet` call is made from here.
 * - **The names accepted in the review dialog.** There is nowhere to persist
 *   them, so they are merged into the document's definitions in memory for
 *   this render only.
 * - **Provenance.** A printed sheet cannot be revoked, so it says where it
 *   came from, when the link stops working, and that it is not a diagnosis
 *   (plan §4).
 *
 * The identity block comes from the link's own header setting: a link shared
 * without the header prints without a name, exactly as it renders without one
 * on screen.
 */
export function SharedPrintEditor({
  record,
  flowsheet,
  namesByLang,
  onBack,
}: {
  record: SharedRecord
  flowsheet: SharedFlowsheet
  /**
   * Translations accepted in the review dialog, per document language and
   * keyed by definition id. Per language because the reader can go back to
   * the setup screen, switch the target language and generate again — the
   * terms accepted for the previous language must not leak into the next
   * document.
   */
  namesByLang: Record<string, Record<string, string>>
  onBack: () => void
}) {
  const { mode, targetLanguage, initFilters } = usePrintConfig()

  // Select every column and every biomarker up front, exactly as the owner's
  // `PrintEditorView` does after its fetch. Without this the editor opens with
  // an EMPTY selection and the document reads "Select at least one date
  // column" — the owner's container did the initialisation, so the shared one
  // has to as well. Deps are the payload and the stable callback only: a
  // locale change must not reset a reader's choices (ISSUES.md #75).
  useEffect(() => {
    initFilters(
      flowsheet.dates.map(dateId),
      flowsheet.matrix.flatMap((category) => category.rows.map((row) => row.id)),
    )
  }, [flowsheet, initFilters])

  // Mirrors PrintEditorView: `original` renders the source-language document,
  // `bilingual` pairs the translation with it, everything else translates.
  let lang: PrintLang = targetLanguage
  let bilingual = false
  if (mode === 'original') {
    lang = 'ru'
  } else if (mode === 'bilingual') {
    bilingual = true
  }

  const biomarkers = useMemo<BiomarkerResult[]>(() => {
    const names = namesByLang[lang] ?? {}
    if (Object.keys(names).length === 0) return record.biomarkers
    return record.biomarkers.map((result) => {
      const definition = result.definition
      const translated = definition ? names[definition.id] : undefined
      if (!definition || !translated) return result
      return {
        ...result,
        definition: {
          ...definition,
          names: { ...(definition.names ?? {}), [lang]: translated },
        },
      }
    })
  }, [record.biomarkers, namesByLang, lang])

  const header = record.header

  return (
    <PrintEditor
      dates={[...flowsheet.dates]}
      matrix={flowsheet.matrix}
      biomarkers={biomarkers}
      lang={lang}
      bilingual={bilingual}
      patient={
        header
          ? {
              id: '',
              email: '',
              name: header.name,
              dob: header.dob,
              gender: header.gender,
              external_id: '',
            }
          : null
      }
      onBack={onBack}
      provenance={{ expiresAt: record.meta.expires_at }}
    />
  )
}
