'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { PrintEditor } from '@/components/health-passport/print-editor'
import {
  fittingColumnCount,
  measureColumnWidths,
  overflowsPage,
} from '@/components/share/print-fit'
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
  const {
    mode,
    targetLanguage,
    initFilters,
    selectedDates,
    setSelectedDates,
  } = usePrintConfig()
  const t = useTranslations('print.editor')
  const wrapRef = useRef<HTMLDivElement>(null)
  // The fit runs once per payload. A reader who then picks more columns keeps
  // them — the warning below is the feedback, not another silent trim.
  const fittedRef = useRef(false)
  const [overflows, setOverflows] = useState(false)

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

  // What the paper can hold, measured from the rendered table (see
  // `print-fit.ts`). The first pass trims the default selection to the newest
  // columns that fit — without it a 27-column record printed four pages that
  // all cut at the same mid-column point, and the newest results were on none
  // of them. Every later pass only reports, so a reader who deliberately picks
  // more columns is warned rather than overruled.
  useLayoutEffect(() => {
    const table = wrapRef.current?.querySelector('table')
    if (!table) return
    const widths = measureColumnWidths(table as HTMLTableElement)
    if (widths.length === 0) return
    setOverflows(overflowsPage(widths))
    if (fittedRef.current) return
    fittedRef.current = true
    const keep = fittingColumnCount(widths)
    if (keep < flowsheet.dates.length) {
      setSelectedDates(flowsheet.dates.slice(-keep).map(dateId))
    }
  }, [flowsheet, selectedDates, setSelectedDates])

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
    <div ref={wrapRef}>
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
        banner={overflows ? t('columnsOverflow') : null}
      />
    </div>
  )
}
