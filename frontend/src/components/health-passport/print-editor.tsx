'use client'

import { Fragment, useMemo, useState } from 'react'
import {
  Printer,
  GripVertical,
  ChevronDown,
  Filter,
  Hash,
} from 'lucide-react'

import { cn, formatNumber, formatNumberFull } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import { formatReference } from '@/lib/reference'
import type { PrintLang, DateHeader, MatrixCategory, BiomarkerResult, BiomarkerDefinition, CurrentUser } from '@/lib/types'

const LANG_NAME: Record<PrintLang, string> = {
  ru: 'Russian',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  he: 'Hebrew',
  pl: 'Polish',
}

// Display names for a document's DETECTED source language (backend detector,
// surfaced on DateHeader.source_language / MatrixRow.original_lang). These
// are unrelated to the PrintLang 'ru' sentinel above, which selects
// "original" mode and is not the Russian language.
const SOURCE_LANG_EN: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pl: 'Polish',
  ru: 'Russian',
  he: 'Hebrew',
}

// Original mode renders Russian chrome, so its label uses Russian names.
const SOURCE_LANG_RU: Record<string, string> = {
  en: '\u0410\u043D\u0433\u043B\u0438\u0439\u0441\u043A\u0438\u0439',
  de: '\u041D\u0435\u043C\u0435\u0446\u043A\u0438\u0439',
  fr: '\u0424\u0440\u0430\u043D\u0446\u0443\u0437\u0441\u043A\u0438\u0439',
  es: '\u0418\u0441\u043F\u0430\u043D\u0441\u043A\u0438\u0439',
  pl: '\u041F\u043E\u043B\u044C\u0441\u043A\u0438\u0439',
  ru: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439',
  he: '\u0418\u0432\u0440\u0438\u0442',
}

const GENDER_RU: Record<string, string> = {
  Male: '\u041C\u0443\u0436\u0447\u0438\u043D\u0430',
  Female: '\u0416\u0435\u043D\u0449\u0438\u043D\u0430',
  Other: '\u0414\u0440\u0443\u0433\u043E\u0435',
}

function formatDob(dob: string, lang: PrintLang): string {
  const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return dob
  const [, y, mo, d] = m
  return lang === 'ru' ? `${d}.${mo}.${y}` : `${mo}.${d}.${y}`
}

function formatToday(lang: PrintLang): string {
  const now = new Date()
  const d = String(now.getDate()).padStart(2, '0')
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const y = now.getFullYear()
  return lang === 'ru' ? `${d}.${mo}.${y}` : `${mo}.${d}.${y}`
}

function genderLabel(gender: string, lang: PrintLang): string {
  const cleaned = gender.trim()
  if (!cleaned) return ''
  if (lang === 'ru' && GENDER_RU[cleaned]) return GENDER_RU[cleaned]
  return cleaned
}

const TABLE_HEADINGS: Record<PrintLang, { biomarker: string; title: string; note: string }> = {
  ru: {
    biomarker: '\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u044C',
    title: '\u0414\u0438\u043D\u0430\u043C\u0438\u043A\u0430 \u043F\u043E \u0438\u0441\u0441\u043B\u0435\u0434\u043E\u0432\u0430\u043D\u0438\u044E',
    note: '* \u0417\u043D\u0430\u0447\u0435\u043D\u0438\u044F \u0432\u043D\u0435 \u0440\u0435\u0444\u0435\u0440\u0435\u043D\u0441\u043D\u043E\u0433\u043E \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430',
  },
  en: {
    biomarker: 'Biomarker',
    title: 'Longitudinal Lab Results',
    note: '* Values outside reference range',
  },
  de: {
    biomarker: 'Biomarker',
    title: 'L\u00E4ngsschnitt der Laborwerte',
    note: '* Werte au\u00DFerhalb des Referenzbereichs',
  },
  fr: {
    biomarker: 'Biomarqueur',
    title: 'R\u00E9sultats de laboratoire longitudinaux',
    note: '* Valeurs hors plage de r\u00E9f\u00E9rence',
  },
  es: {
    biomarker: 'Biomarcador',
    title: 'Resultados de laboratorio longitudinales',
    note: '* Valores fuera del rango de referencia',
  },
  he: {
    biomarker: '\u05E1\u05DE\u05DF \u05D1\u05D9\u05D5\u05DC\u05D5\u05D2\u05D9',
    title: '\u05EA\u05D5\u05E6\u05D0\u05D5\u05EA \u05DE\u05E2\u05D1\u05D3\u05D4 \u05DC\u05D0\u05D5\u05E8\u05DA \u05D6\u05DE\u05DF',
    note: '* \u05E2\u05E8\u05DB\u05D9\u05DD \u05DE\u05D7\u05D5\u05E5 \u05DC\u05D8\u05D5\u05D5\u05D7 \u05D4\u05D9\u05D7\u05D9\u05E1',
  },
  pl: {
    biomarker: 'Biomarker',
    title: 'Wyniki bada\u0144 laboratoryjnych w czasie',
    note: '* Warto\u015Bci poza zakresem referencyjnym',
  },
}

function dateId(d: DateHeader): string {
  return d.label + (d.sub ? '--' + d.sub : '')
}


function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  )
}

function extractYear(label: string): number {
  const m = label.match(/, (\d{4})/)
  if (m) return parseInt(m[1], 10)
  return new Date().getFullYear()
}

export function PrintEditor({
  dates,
  matrix,
  biomarkers = [],
  lang,
  bilingual,
  onBack,
  patient = null,
}: {
  dates: DateHeader[]
  matrix: MatrixCategory[]
  biomarkers?: BiomarkerResult[]
  lang: PrintLang
  bilingual: boolean
  onBack: () => void
  patient?: CurrentUser | null
}) {
  const {
    layout,
    textSize,
    selectedDates,
    selectedBiomarkers,
    showAbnormalOnly,
    setLayout,
    setTextSize,
    setSelectedDates,
    setSelectedBiomarkers,
    setShowAbnormalOnly,
    showReferences,
    setShowReferences,
    compactNumbers,
    setCompactNumbers,
    categoryTranslations,
    suppressSavedTranslations,
  } = usePrintConfig()

  const [openCats, setOpenCats] = useState<string[]>(matrix.map((c) => c.category))
  const [dragInfo, setDragInfo] = useState<{ cat: string; id: string } | null>(null)
  const [order, setOrder] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(matrix.map((c) => [c.category, c.rows.map((r) => r.id)])),
  )

  const headings = TABLE_HEADINGS[lang]
  const isRtl = lang === 'he'

  const defMap = useMemo(() => {
    const map = new Map<string, BiomarkerDefinition>()
    for (const b of biomarkers) {
      if (b.definition) map.set(b.definition.id, b.definition)
    }
    return map
  }, [biomarkers])

  const visibleDateIndices = useMemo(
    () => dates.map((_, i) => i).filter((i) => selectedDates.includes(dateId(dates[i]))),
    [dates, selectedDates],
  )
  const visibleDates = visibleDateIndices.map((i) => dates[i])

  // The source-document language behind the selected date columns. A specific
  // label is only shown when every selected column carries the SAME detected
  // language; mixed or unknown (legacy/manual) columns fall back to a generic
  // "Original" label.
  const uniformSourceLang = useMemo(() => {
    let lang: string | null = null
    for (const d of visibleDates) {
      if (!d.source_language) return null
      if (lang === null) lang = d.source_language
      else if (lang !== d.source_language) return null
    }
    return lang
  }, [visibleDates])

  const visibleMatrix = useMemo(() => {
    return matrix
      .map((cat) => {
        const catOrder = order[cat.category] || cat.rows.map((r) => r.id)
        const orderedRows = catOrder
          .map((id) => cat.rows.find((r) => r.id === id)!)
          .filter(Boolean)
        const filtered = orderedRows.filter((row) => {
          if (!selectedBiomarkers.includes(row.id)) return false
          const hasData = visibleDateIndices.some((i) => {
            const cell = row.cells[i]
            return cell && cell.value && cell.value !== '\u2014'
          })
          if (!hasData) return false
          if (showAbnormalOnly) {
            const cells = visibleDateIndices.map((i) => row.cells[i]).filter(Boolean)
            return cells.some((c) => c.status !== 'normal')
          }
          return true
        })
        return { ...cat, rows: filtered }
      })
      .filter((cat) => cat.rows.length > 0)
  }, [matrix, order, selectedBiomarkers, showAbnormalOnly, visibleDateIndices])

  function toggleDateId(d: DateHeader) {
    const id = dateId(d)
    setSelectedDates(
      selectedDates.includes(id)
        ? selectedDates.filter((x) => x !== id)
        : [...selectedDates, id],
    )
  }

  function preset(count: number | 'all') {
    const ids = dates.map((d) => dateId(d))
    if (count === 'all') setSelectedDates([...ids])
    else setSelectedDates(ids.slice(-count))
  }

  function toggleBiomarker(id: string) {
    setSelectedBiomarkers(
      selectedBiomarkers.includes(id)
        ? selectedBiomarkers.filter((x) => x !== id)
        : [...selectedBiomarkers, id],
    )
  }

  function toggleCat(name: string) {
    setOpenCats((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name],
    )
  }

  function handleDrop(cat: string, targetId: string) {
    if (!dragInfo || dragInfo.cat !== cat || dragInfo.id === targetId) return
    setOrder((prev) => {
      const list = [...(prev[cat] || [])]
      const from = list.indexOf(dragInfo.id)
      const to = list.indexOf(targetId)
      if (from === -1 || to === -1) return prev
      list.splice(from, 1)
      list.splice(to, 0, dragInfo.id)
      return { ...prev, [cat]: list }
    })
    setDragInfo(null)
  }

  function translatedName(row: MatrixCategory['rows'][number]): string {
    if (lang === 'ru') return row.original || row.name
    // After a failed generate we force the English / source names for this
    // navigation so the "fallback to English" contract holds even though
    // saved translations may exist on the definition.
    if (suppressSavedTranslations) return row.name
    const def = defMap.get(row.id)
    const val = def?.names?.[lang]
    if (val) return val
    return row.name
  }

  function rowLabel(row: MatrixCategory['rows'][number]) {
    if (bilingual && lang !== 'ru') {
      return `${translatedName(row)} / ${row.original}`
    }
    return translatedName(row)
  }

  /** Display label for a category heading: the AI translation from the
   * generate step when one exists (grouping/order keys stay the raw string),
   * else the raw string. Bilingual mode pairs translation / original. */
  function categoryLabel(category: string): string {
    // After a failed generate the raw heading is forced for this navigation.
    if (suppressSavedTranslations) return category
    const tr = categoryTranslations[category]
    if (!tr) return category
    if (bilingual && lang !== 'ru') return `${tr} / ${category}`
    return tr
  }

  const years = useMemo(() => {
    const set = new Set(dates.map((d) => extractYear(d.label)))
    return [...set].sort((a, b) => a - b)
  }, [dates])

  return (
    <div className="flex h-screen flex-col print:block print:h-auto">
      <style>{`
        @media print {
          @page {
            size: ${layout};
          }
        }
      `}</style>
      <div className="flex items-center justify-between border-b border-border bg-card px-5 py-2.5 print:hidden">
        <Button
          variant="ghost"
          onClick={onBack}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          {'\u2190'} Back to Setup
        </Button>
        <h1 className="text-sm font-semibold text-foreground">
          Document Editor
        </h1>
        <div className="w-[120px]" />
      </div>

      <div className="flex min-h-0 flex-1 print:m-0 print:block print:p-0">
        <aside className="flex w-[350px] shrink-0 flex-col border-r border-border bg-card print:hidden">
          <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
            <section>
              <SectionTitle>Formatting & Layout</SectionTitle>
              <div className="space-y-4">
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Orientation
                  </p>
                  <div className="flex overflow-hidden rounded-lg border border-border">
                    {(['portrait', 'landscape'] as const).map((o) => (
                      <button
                        key={o}
                        onClick={() => setLayout(o)}
                        className={cn(
                          'flex-1 px-2 py-2 text-center text-xs font-medium capitalize transition-colors',
                          layout === o
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-card text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      Text Size
                    </span>
                    <span className="text-xs font-semibold text-foreground">
                      {textSize}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={8}
                    max={14}
                    step={1}
                    value={textSize}
                    onChange={(e) => setTextSize(Number(e.target.value))}
                    className="w-full accent-primary"
                    aria-label="Text size"
                  />
                </div>
              </div>
            </section>

            <section>
              <SectionTitle>Columns (Dates)</SectionTitle>
              <div className="mb-3 flex gap-1.5">
                {[
                  { label: 'Last 3', val: 3 },
                  { label: 'Last 5', val: 5 },
                  { label: 'Last 10', val: 10 },
                  { label: 'All', val: 'all' as const },
                ].map((p) => (
                  <button
                    key={p.label}
                    onClick={() => preset(p.val)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="space-y-3">
                {years.map((year) => (
                  <div key={year}>
                    <p className="mb-1 text-[11px] font-semibold text-foreground">
                      {year}
                    </p>
                    <div className="grid grid-cols-2 gap-1">
                      {dates
                        .filter((d) => extractYear(d.label) === year)
                        .map((d) => (
                          <label
                            key={dateId(d)}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-foreground transition-colors hover:bg-accent"
                          >
                            <input
                              type="checkbox"
                              checked={selectedDates.includes(dateId(d))}
                              onChange={() => toggleDateId(d)}
                              className="size-4 accent-primary"
                            />
                            {d.label}
                          </label>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <SectionTitle>Rows (Biomarkers)</SectionTitle>

              <button
                onClick={() => setShowAbnormalOnly(!showAbnormalOnly)}
                className={cn(
                  'mb-3 flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors',
                  showAbnormalOnly
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent',
                )}
              >
                <span className="flex items-center gap-2">
                  <Filter className="size-4 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      Show Abnormal Only
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      Hides all normal results
                    </span>
                  </span>
                </span>
                <span
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                    showAbnormalOnly ? 'bg-primary' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 size-4 rounded-full bg-background transition-all',
                      showAbnormalOnly ? 'left-4' : 'left-0.5',
                    )}
                  />
                </span>
              </button>

              <button
                onClick={() => setShowReferences(!showReferences)}
                className={cn(
                  'mb-3 flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors',
                  showReferences
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent',
                )}
              >
                <span className="flex items-center gap-2">
                  <Filter className="size-4 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      Show Reference Ranges
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      Display reference range below each biomarker
                    </span>
                  </span>
                </span>
                <span
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                    showReferences ? 'bg-primary' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 size-4 rounded-full bg-background transition-all',
                      showReferences ? 'left-4' : 'left-0.5',
                    )}
                  />
                </span>
              </button>

              <button
                onClick={() => setCompactNumbers(!compactNumbers)}
                className={cn(
                  'mb-3 flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors',
                  compactNumbers
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent',
                )}
              >
                <span className="flex items-center gap-2">
                  <Hash className="size-4 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      Compact Large Numbers
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      Show 10M, 1B instead of 10,000,000
                    </span>
                  </span>
                </span>
                <span
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                    compactNumbers ? 'bg-primary' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 size-4 rounded-full bg-background transition-all',
                      compactNumbers ? 'left-4' : 'left-0.5',
                    )}
                  />
                </span>
              </button>

              <div className="space-y-2">
                {matrix.map((cat) => {
                  const open = openCats.includes(cat.category)
                  return (
                    <div
                      key={cat.category}
                      className="overflow-hidden rounded-lg border border-border"
                    >
                      <button
                        onClick={() => toggleCat(cat.category)}
                        className="flex w-full items-center justify-between bg-secondary/40 px-3 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
                      >
                        {categoryLabel(cat.category)}
                        <ChevronDown
                          className={cn(
                            'size-4 text-muted-foreground transition-transform',
                            open && 'rotate-180',
                          )}
                        />
                      </button>
                      {open && (
                        <div className="divide-y divide-border">
                          {(order[cat.category] || cat.rows.map((r) => r.id)).map((id) => {
                            const row = cat.rows.find((r) => r.id === id)
                            if (!row) return null
                            const isHidden = !selectedBiomarkers.includes(id)
                            return (
                              <div
                                key={id}
                                draggable
                                onDragStart={() =>
                                  setDragInfo({ cat: cat.category, id })
                                }
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={() => handleDrop(cat.category, id)}
                                className={cn(
                                  'flex items-center gap-2 px-2.5 py-2',
                                  isHidden && 'opacity-50',
                                  dragInfo?.id === id && 'bg-accent',
                                )}
                              >
                                <GripVertical className="size-3.5 cursor-grab text-muted-foreground active:cursor-grabbing" />
                                <input
                                  type="checkbox"
                                  checked={!isHidden}
                                  onChange={() => toggleBiomarker(id)}
                                  className="size-4 accent-primary"
                                  aria-label={`Show ${row.name}`}
                                />
                                <span
                                  className={cn(
                                    'flex-1 truncate text-sm text-foreground',
                                    isHidden && 'line-through',
                                  )}
                                >
                                  {row.name}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          </div>

          <div className="sticky bottom-0 border-t border-border bg-card px-5 py-4">
            <Button
              className="h-11 w-full text-sm"
              onClick={() => window.print()}
            >
              <Printer className="size-4" />
              Print Document
            </Button>
          </div>
        </aside>

        <div className="flex-1 overflow-y-auto bg-slate-100 p-8 print:overflow-visible print:bg-white print:p-0">
          <div
            dir={isRtl ? 'rtl' : 'ltr'}
            className={cn(
              'mx-auto bg-white p-8 text-slate-900 shadow-xl',
              'print:m-0 print:max-w-none print:p-0 print:shadow-none',
              layout === 'portrait' ? 'max-w-3xl' : 'max-w-5xl',
            )}
            style={{ fontSize: `${textSize}px`, colorScheme: 'light' }}
          >
            <div className="mb-3 flex items-start justify-between border-b border-gray-400 pb-2">
              {patient ? (
                <div>
                  <div className="font-semibold">
                    {patient.name?.trim() || '\u2014'}
                  </div>
                  <div className="text-gray-600">
                    {(patient.dob || patient.gender) && (
                      <span>
                        {patient.dob
                          ? `${lang === 'ru' ? '\u0414\u0420' : 'DOB'}: ${formatDob(patient.dob, lang)}`
                          : ''}
                        {patient.dob && patient.gender ? ' \u00B7 ' : ''}
                        {genderLabel(patient.gender, lang)}
                      </span>
                    )}
                  </div>
                </div>
              ) : null}
              <div className="text-right text-gray-600">
                <div>
                  {lang === 'ru'
                    ? `\u0414\u0430\u0442\u0430: ${formatToday(lang)}`
                    : `Generated: ${formatToday(lang)}`}
                </div>
                <div>
                  {lang === 'ru'
                    ? `\u042F\u0437\u044B\u043A: \u041E\u0440\u0438\u0433\u0438\u043D\u0430\u043B${uniformSourceLang ? ` (${SOURCE_LANG_RU[uniformSourceLang] ?? ''})` : ''}`
                    : `Language: ${LANG_NAME[lang]}`}
                  {bilingual
                    ? ` + ${uniformSourceLang ? `Original (${SOURCE_LANG_EN[uniformSourceLang] ?? ''})` : 'Original'}`
                    : ''}
                </div>
              </div>
            </div>

            <h2 className="mb-3 text-center font-bold" style={{ fontSize: `${textSize + 2}px` }}>
              {bilingual && lang !== 'ru'
                ? `${headings.title} / ${TABLE_HEADINGS.ru.title}`
                : headings.title}
            </h2>

            {visibleDates.length === 0 || visibleMatrix.length === 0 ? (
              <p className="py-8 text-center text-gray-500">
                {visibleDates.length === 0
                  ? 'Select at least one date column.'
                  : 'No biomarkers match your filters.'}
              </p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="border border-gray-300 bg-gray-50 px-2 py-0.5 text-left font-semibold">
                      {bilingual && lang !== 'ru'
                        ? `${headings.biomarker} / ${TABLE_HEADINGS.ru.biomarker}`
                        : headings.biomarker}
                    </th>
                    {visibleDates.map((d) => (
                      <th
                        key={dateId(d)}
                        className="border border-gray-300 bg-gray-50 px-2 py-0.5 text-center font-semibold"
                      >
                        {d.label}
                        {d.sub && <span className="block text-[10px] font-normal">{d.sub}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleMatrix.map((cat) => (
                    <Fragment key={cat.category}>
                      <tr>
                        <td
                          colSpan={visibleDates.length + 1}
                          className="border border-gray-300 bg-gray-100 px-2 py-0.5 font-semibold uppercase tracking-wide text-gray-700"
                        >
                          {categoryLabel(cat.category)}
                        </td>
                      </tr>
                      {cat.rows.map((row) => (
                        <tr key={row.id}>
                          <td className="border border-gray-300 px-2 py-0.5">
                            <span className="font-medium">{rowLabel(row)}</span>
                            {showReferences && row.reference && (
                              <span className="block text-[0.75em] text-gray-400 leading-tight">
                                {formatReference(row.reference, row.unit, { full: !compactNumbers })}
                              </span>
                            )}
                          </td>
                          {visibleDateIndices.map((di) => {
                            const cell = row.cells[di]
                            if (!cell || cell.value === '\u2014') {
                              return (
                                <td
                                  key={row.id + '-' + di}
                                  className="border border-gray-300 px-2 py-0.5 text-center text-gray-400"
                                >
                                  {'\u2014'}
                                </td>
                              )
                            }
                            return (
                              <td
                                key={row.id + '-' + di}
                                className={cn(
                                  'border border-gray-300 px-2 py-0.5 text-center tabular-nums',
                                  cell.status !== 'normal' && 'font-semibold text-red-600',
                                )}
                              >
                                {compactNumbers ? formatNumber(cell.value) : formatNumberFull(cell.value)}
                                {cell.status !== 'normal' ? '\u00A0*' : ''}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}

            <p className="mt-3 text-gray-500">
              {bilingual && lang !== 'ru'
                ? `${headings.note} / ${TABLE_HEADINGS.ru.note}`
                : headings.note}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
