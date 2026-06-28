'use client'

import { Fragment, useState } from 'react'
import {
  Printer,
  GripVertical,
  ChevronDown,
  Filter,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/shared/Field'
import type { PrintLang, DateCol, Marker, PrintCategory } from '@/lib/types'

const LANG_NAME: Record<PrintLang, string> = {
  ru: 'Russian',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  he: 'Hebrew',
}

const ALL_DATES: DateCol[] = [
  { id: 'd01', year: '2023', short: 'Mar 15', ru: '15.03.23' },
  { id: 'd02', year: '2024', short: 'Jan 20', ru: '20.01.24' },
  { id: 'd03', year: '2024', short: 'Aug 10', ru: '10.08.24' },
  { id: 'd04', year: '2025', short: 'Feb 02', ru: '02.02.25' },
  { id: 'd05', year: '2025', short: 'Jun 14', ru: '14.06.25' },
  { id: 'd06', year: '2025', short: 'Aug 18', ru: '18.08.25' },
  { id: 'd07', year: '2025', short: 'Nov 03', ru: '03.11.25' },
  { id: 'd08', year: '2026', short: 'Jan 15', ru: '15.01.26' },
  { id: 'd09', year: '2026', short: 'Mar 06', ru: '06.03.26' },
  { id: 'd10', year: '2026', short: 'Apr 22', ru: '22.04.26' },
  { id: 'd11', year: '2026', short: 'Jul 10', ru: '10.07.26' },
  { id: 'd12', year: '2026', short: 'Aug 20', ru: '20.08.26' },
  { id: 'd13', year: '2026', short: 'Sep 05', ru: '05.09.26' },
  { id: 'd14', year: '2026', short: 'Sep 28', ru: '28.09.26' },
  { id: 'd15', year: '2026', short: 'Oct 12', ru: '12.10.26' },
]

const CHRONO = ['d15', 'd14', 'd13', 'd12', 'd11', 'd10', 'd09', 'd08', 'd07', 'd06', 'd05', 'd04', 'd03', 'd02', 'd01']

const MARKERS: Record<string, Marker> = {
  hgb: {
    id: 'hgb',
    unit: 'g/dL',
    labels: {
      en: 'Hemoglobin',
      ru: 'Гемоглобин',
      de: 'Hämoglobin',
      fr: 'Hémoglobine',
      es: 'Hemoglobina',
      he: 'המוגלובין',
    },
    values: {
      d01: { v: '13.2' },
      d02: { v: '13.8' },
      d03: { v: '14.0' },
      d04: { v: '13.6' },
      d05: { v: '14.2' },
      d06: { v: '14.5' },
      d07: { v: '13.9' },
      d08: { v: '13.8' },
      d09: { v: '14.5' },
      d10: { v: '14.1' },
      d11: { v: '13.7' },
      d12: { v: '14.0' },
      d13: { v: '14.0' },
      d14: { v: '14.3' },
      d15: { v: '14.2' },
    },
  },
  wbc: {
    id: 'wbc',
    unit: 'x10⁹/L',
    labels: {
      en: 'Leukocytes',
      ru: 'Лейкоциты',
      de: 'Leukozyten',
      fr: 'Leucocytes',
      es: 'Leucocitos',
      he: 'לויקוציטים',
    },
    values: {
      d01: { v: '8.20' },
      d02: { v: '8.64' },
      d03: { v: '8.00' },
      d04: { v: '8.20' },
      d05: { v: '7.60' },
      d06: { v: '7.90' },
      d07: { v: '8.30' },
      d08: { v: '12.40', abnormal: true },
      d09: { v: '24.49', abnormal: true },
      d10: { v: '10.10', abnormal: true },
      d11: { v: '9.50', abnormal: true },
      d12: { v: '9.80', abnormal: true },
      d13: { v: '9.10', abnormal: true },
      d14: { v: '8.70' },
      d15: { v: '8.80' },
    },
  },
  lymph: {
    id: 'lymph',
    unit: '%',
    labels: {
      en: 'Lymphocytes, %',
      ru: 'Лимфоциты, %',
      de: 'Lymphozyten, %',
      fr: 'Lymphocytes, %',
      es: 'Linfocitos, %',
      he: 'לימפוציטים, %',
    },
    values: {
      d01: { v: '30.0' },
      d02: { v: '33.0' },
      d03: { v: '28.0' },
      d04: { v: '38.0' },
      d05: { v: '36.0' },
      d06: { v: '35.0' },
      d07: { v: '37.0' },
      d08: { v: '40.8', abnormal: true },
      d09: { v: '52.7', abnormal: true },
      d10: { v: '45.2', abnormal: true },
      d11: { v: '38.0' },
      d12: { v: '42.0', abnormal: true },
      d13: { v: '32.0' },
      d14: { v: '39.0' },
      d15: { v: '41.0', abnormal: true },
    },
  },
  ferr: {
    id: 'ferr',
    unit: 'ng/mL',
    labels: {
      en: 'Ferritin',
      ru: 'Ферритин',
      de: 'Ferritin',
      fr: 'Ferritine',
      es: 'Ferritina',
      he: 'פריטין',
    },
    values: {
      d01: { v: '18.5', abnormal: true },
      d02: { v: '16.2', abnormal: true },
      d03: { v: '24.0', abnormal: true },
      d04: { v: '41.5' },
      d05: { v: '36.0' },
      d06: { v: '50.4' },
      d07: { v: '45.0' },
      d08: { v: '32.0' },
      d09: { v: '32.0' },
      d10: { v: '35.0' },
      d11: { v: '30.5' },
      d12: { v: '26.0', abnormal: true },
      d13: { v: '28.5', abnormal: true },
      d14: { v: '24.0', abnormal: true },
      d15: { v: '22.0', abnormal: true },
    },
  },
}

const CATEGORIES: PrintCategory[] = [
  { id: 'cbc', name: 'Complete Blood Count (CBC)', markers: ['hgb', 'wbc', 'lymph'] },
  { id: 'iron', name: 'Iron Panel', markers: ['ferr'] },
]

const TABLE_HEADINGS: Record<PrintLang, { biomarker: string; title: string; note: string }> = {
  ru: {
    biomarker: 'Показатель',
    title: 'Динамика по исследованию',
    note: '* Значения вне референсного диапазона',
  },
  en: {
    biomarker: 'Biomarker',
    title: 'Longitudinal Lab Results',
    note: '* Values outside reference range',
  },
  de: {
    biomarker: 'Biomarker',
    title: 'Längsschnitt der Laborwerte',
    note: '* Werte außerhalb des Referenzbereichs',
  },
  fr: {
    biomarker: 'Biomarqueur',
    title: 'Résultats de laboratoire longitudinaux',
    note: '* Valeurs hors plage de référence',
  },
  es: {
    biomarker: 'Biomarcador',
    title: 'Resultados de laboratorio longitudinales',
    note: '* Valores fuera del rango de referencia',
  },
  he: {
    biomarker: 'סמן ביולוגי',
    title: 'תוצאות מעבדה לאורך זמן',
    note: '* ערכים מחוץ לטווח הייחוס',
  },
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  )
}

export function PrintEditor({
  lang,
  bilingual,
  onBack,
}: {
  lang: PrintLang
  bilingual: boolean
  onBack: () => void
}) {
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(
    'portrait',
  )
  const [fontSize, setFontSize] = useState(10)
  const [activeDates, setActiveDates] = useState<string[]>(['d15', 'd14'])
  const [outOfRangeOnly, setOutOfRangeOnly] = useState(false)
  const [hidden, setHidden] = useState<string[]>([])
  const [order, setOrder] = useState<Record<string, string[]>>(
    Object.fromEntries(CATEGORIES.map((c) => [c.id, [...c.markers]])),
  )
  const [openCats, setOpenCats] = useState<string[]>(CATEGORIES.map((c) => c.id))
  const [dragInfo, setDragInfo] = useState<{ cat: string; id: string } | null>(
    null,
  )

  const headings = TABLE_HEADINGS[lang]
  const isRtl = lang === 'he'

  const visibleDates = CHRONO.filter((id) => activeDates.includes(id)).map(
    (id) => ALL_DATES.find((d) => d.id === id)!,
  )

  function markerIsAbnormal(m: Marker) {
    return visibleDates.some((d) => m.values[d.id]?.abnormal)
  }

  function toggleDate(id: string) {
    setActiveDates((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  function preset(count: number | 'all') {
    if (count === 'all') setActiveDates([...CHRONO])
    else setActiveDates(CHRONO.slice(0, count))
  }

  function toggleHidden(id: string) {
    setHidden((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  function toggleCat(id: string) {
    setOpenCats((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  function handleDrop(cat: string, targetId: string) {
    if (!dragInfo || dragInfo.cat !== cat || dragInfo.id === targetId) return
    setOrder((prev) => {
      const list = [...prev[cat]]
      const from = list.indexOf(dragInfo.id)
      const to = list.indexOf(targetId)
      if (from === -1 || to === -1) return prev
      list.splice(from, 1)
      list.splice(to, 0, dragInfo.id)
      return { ...prev, [cat]: list }
    })
    setDragInfo(null)
  }

  function rowLabel(m: Marker) {
    if (bilingual && lang !== 'ru') {
      return `${m.labels[lang]} / ${m.labels.ru}`
    }
    return m.labels[lang]
  }

  function colLabel(d: DateCol) {
    return lang === 'ru' ? d.ru : d.short
  }

  const previewCats = CATEGORIES.map((c) => {
    const markers = order[c.id]
      .map((id) => MARKERS[id])
      .filter((m) => !hidden.includes(m.id))
      .filter((m) => !outOfRangeOnly || markerIsAbnormal(m))
    return { ...c, markers }
  }).filter((c) => c.markers.length > 0)

  const years = [...new Set(ALL_DATES.map((d) => d.year))].sort()

  return (
    <div className="flex h-screen flex-col print:block print:h-auto">
      <div className="flex items-center justify-between border-b border-border bg-card px-5 py-2.5 print:hidden">
        <Button
          variant="ghost"
          onClick={onBack}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          ← Back to Setup
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
                        onClick={() => setOrientation(o)}
                        className={cn(
                          'flex-1 px-2 py-2 text-center text-xs font-medium capitalize transition-colors',
                          orientation === o
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
                      {fontSize}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={8}
                    max={14}
                    step={1}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
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
                  { label: 'All 15', val: 'all' as const },
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
                      {ALL_DATES.filter((d) => d.year === year).map((d) => (
                        <label
                          key={d.id}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-foreground transition-colors hover:bg-accent"
                        >
                          <input
                            type="checkbox"
                            checked={activeDates.includes(d.id)}
                            onChange={() => toggleDate(d.id)}
                            className="size-4 accent-primary"
                          />
                          {d.short}
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
                onClick={() => setOutOfRangeOnly((v) => !v)}
                className={cn(
                  'mb-3 flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors',
                  outOfRangeOnly
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent',
                )}
              >
                <span className="flex items-center gap-2">
                  <Filter className="size-4 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">
                      Show Out-of-Range Only
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      Hides all normal results
                    </span>
                  </span>
                </span>
                <span
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                    outOfRangeOnly ? 'bg-primary' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 size-4 rounded-full bg-background transition-all',
                      outOfRangeOnly ? 'left-4' : 'left-0.5',
                    )}
                  />
                </span>
              </button>

              <div className="space-y-2">
                {CATEGORIES.map((cat) => {
                  const open = openCats.includes(cat.id)
                  return (
                    <div
                      key={cat.id}
                      className="overflow-hidden rounded-lg border border-border"
                    >
                      <button
                        onClick={() => toggleCat(cat.id)}
                        className="flex w-full items-center justify-between bg-secondary/40 px-3 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
                      >
                        {cat.name}
                        <ChevronDown
                          className={cn(
                            'size-4 text-muted-foreground transition-transform',
                            open && 'rotate-180',
                          )}
                        />
                      </button>
                      {open && (
                        <div className="divide-y divide-border">
                          {order[cat.id].map((id) => {
                            const m = MARKERS[id]
                            const isHidden = hidden.includes(id)
                            return (
                              <div
                                key={id}
                                draggable
                                onDragStart={() =>
                                  setDragInfo({ cat: cat.id, id })
                                }
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={() => handleDrop(cat.id, id)}
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
                                  onChange={() => toggleHidden(id)}
                                  className="size-4 accent-primary"
                                  aria-label={`Show ${m.labels.en}`}
                                />
                                <span
                                  className={cn(
                                    'flex-1 truncate text-sm text-foreground',
                                    isHidden && 'line-through',
                                  )}
                                >
                                  {m.labels.en}
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
              orientation === 'portrait' ? 'max-w-3xl' : 'max-w-5xl',
            )}
            style={{ fontSize: `${fontSize}px` }}
          >
            <div className="mb-3 flex items-start justify-between border-b border-gray-400 pb-2">
              <div>
                <div className="font-semibold">
                  {lang === 'ru' ? 'Иванов Алексей' : 'Alexey Ivanov'}
                </div>
                <div className="text-gray-600">
                  {lang === 'ru' ? 'ДР: 14.03.1988 · Муж' : 'DOB: 14.03.1988 · Male'}
                </div>
              </div>
              <div className="text-right text-gray-600">
                <div>
                  {lang === 'ru'
                    ? 'Дата: 12.10.2026'
                    : 'Generated: 10/12/2026'}
                </div>
                <div>
                  {lang === 'ru' ? 'Язык: Русский' : `Language: ${LANG_NAME[lang]}`}
                  {bilingual ? ' + RU' : ''}
                </div>
              </div>
            </div>

            <h2 className="mb-3 text-center font-bold" style={{ fontSize: `${fontSize + 2}px` }}>
              {bilingual && lang !== 'ru'
                ? `${headings.title} / ${TABLE_HEADINGS.ru.title}`
                : headings.title}
            </h2>

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
                      key={d.id}
                      className="border border-gray-300 bg-gray-50 px-2 py-0.5 text-center font-semibold"
                    >
                      {colLabel(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewCats.map((cat) => (
                  <Fragment key={cat.id}>
                    <tr>
                      <td
                        colSpan={visibleDates.length + 1}
                        className="border border-gray-300 bg-gray-100 px-2 py-0.5 font-semibold uppercase tracking-wide text-gray-700"
                      >
                        {cat.name}
                      </td>
                    </tr>
                    {cat.markers.map((m) => (
                      <tr key={m.id}>
                        <td className="border border-gray-300 px-2 py-0.5">
                          <span className="font-medium">{rowLabel(m)}</span>
                          <span className="text-gray-500"> ({m.unit})</span>
                        </td>
                        {visibleDates.map((d) => {
                          const cell = m.values[d.id]
                          return (
                            <td
                              key={d.id}
                              className={cn(
                                'border border-gray-300 px-2 py-0.5 text-center tabular-nums',
                                cell?.abnormal && 'font-semibold text-red-600',
                              )}
                            >
                              {cell ? `${cell.v}${cell.abnormal ? ' *' : ''}` : '—'}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>

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
