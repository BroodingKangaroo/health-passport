'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Search, ChevronRight, ArrowDown, ArrowUp } from 'lucide-react'

import { cn, formatNumber } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Sparkline } from '@/components/shared/Sparkline'
import { ScaleNote } from '@/components/shared/ScaleNote'
import { formatReference, isQualitative } from '@/lib/reference'
import { coerceChartValue, chartReferenceBounds } from '@/lib/chart-series'
import { qualitativeLabel } from '@/lib/qualitative-labels'
import { activateOnKey } from '@/lib/a11y'
import { STATUS_TEXT_CLASS as statusText, isOutOfRange } from '@/lib/status-labels'
import type { DateHeader, MatrixCategory, MatrixCell, BiomarkerResult } from '@/lib/types'

// Fixed frozen-column widths. The name column MUST be a fixed pixel width
// (not minmax): the trend column's sticky `left` offset is a plain CSS
// value that cannot track a flexible name column, so a minmax name would
// open a gap (or overlap) between the two frozen columns whenever the grid
// is narrower than its max (e.g. a fresh account with few date columns).
const NAME_COL_PX = 220
const TREND_COL_PX = 80
const MIN_DATE_COL_PX = 84

// The backend marks "no reading in this column" with an em dash (see
// _matrix_cell in the flowsheet API). Distinct from qualitative RESULTS
// like "Absent"/"Отсутствует", which are real measured values and must
// never be collapsed into the same dash.
const EMPTY_CELL_VALUE = '—'

type RangePreset = number | 'all'
const RANGE_PRESETS: RangePreset[] = [6, 12, 'all']
// Show the range presets only once there are enough columns for them to
// matter (with ≤6 columns "last 6" would be identical to "all").
const RANGE_PRESET_MIN_COLUMNS = 7

function splitDateLabel(label: string): { day: string; year: string | null } {
  // Backend labels are "Mar 20" (current year) or "Mar 20, 2023".
  const m = label.match(/^(.+?),\s*(\d{4})$/)
  if (m) return { day: m[1], year: m[2] }
  return { day: label, year: null }
}

function Cell({ cell }: { cell: MatrixCell }) {
  const locale = useLocale()
  const t = useTranslations('timeline.flowsheet')
  const isOut = isOutOfRange(cell.status)
  if (cell.value === EMPTY_CELL_VALUE) {
    return (
      <span
        className="pl-3 text-right text-muted-foreground/30"
        title={t('notMeasured')}
      >
        {EMPTY_CELL_VALUE}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'flex items-center justify-end gap-1 pl-3 text-[13px] tabular-nums',
        isOut ? cn('font-bold', statusText[cell.status]) : 'text-foreground',
      )}
      title={cell.value}
    >
      {qualitativeLabel(formatNumber(cell.value), locale)}
      <ScaleNote
        className="ml-0.5"
        scaleFunction={cell.scale_function}
        needsReview={cell.needs_review}
      />
      {cell.status === 'low' && <ArrowDown className="size-3.5" />}
      {cell.status === 'high' && <ArrowUp className="size-3.5" />}
    </span>
  )
}

interface FlowsheetMatrixProps {
  dates: readonly DateHeader[]
  matrix: MatrixCategory[]
  biomarkers: BiomarkerResult[]
}

export function FlowsheetMatrix({ dates, matrix, biomarkers }: FlowsheetMatrixProps) {
  const router = useRouter()
  const t = useTranslations('timeline.flowsheet')
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [range, setRange] = useState<RangePreset>('all')

  const shownDates = useMemo(
    () => (range === 'all' ? dates : dates.slice(-range)),
    [dates, range],
  )

  const gridTemplateCols = `${NAME_COL_PX}px ${TREND_COL_PX}px ${shownDates
    .map(() => `minmax(${MIN_DATE_COL_PX}px, 1fr)`)
    .join(' ')} 32px`
  const gridMinWidth =
    NAME_COL_PX +
    TREND_COL_PX +
    shownDates.length * MIN_DATE_COL_PX +
    32
  const GRID_COLS = 'items-center'

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return matrix
    return matrix
      .map((cat) => ({
        ...cat,
        rows: cat.rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.original.toLowerCase().includes(q),
        ),
      }))
      .filter((cat) => cat.rows.length > 0)
  }, [query, matrix])

  return (
    <Card className="overflow-hidden border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="leading-tight">
          <h2 className="text-base font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('subtitle')}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">
            <span aria-hidden className="mr-1">{EMPTY_CELL_VALUE}</span>
            {t('legendNotMeasured')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {dates.length >= RANGE_PRESET_MIN_COLUMNS && (
            // Presets are the wide-screen remedy for 20+ panels: at the 84px
            // column minimum a 19-column matrix barely overflows on a large
            // monitor (scroll room stays small by design) — do not widen the
            // date columns to "use the space"; narrowing the window here is
            // what keeps the grid readable.
            <div className="flex items-center gap-2">
              {range !== 'all' && (
                <span className="text-[11px] text-muted-foreground">
                  {t('showingCount', { shown: shownDates.length, total: dates.length })}
                </span>
              )}
              <div
                className="flex items-center rounded-lg border border-border p-0.5"
                role="group"
                aria-label={t('rangePickerLabel')}
              >
                {RANGE_PRESETS.map((preset) => {
                  const active = range === preset
                  const label =
                    preset === 'all' ? t('rangeAll') : t('rangeLast', { n: preset })
                  return (
                    <button
                      key={String(preset)}
                      onClick={() => setRange(preset)}
                      aria-pressed={active}
                      className={cn(
                        'whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                        active
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('filterPlaceholder')}
              className="pl-8"
            />
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        {/* The wrapper must be exactly as wide as the tracks' minimum sum:
            a plain block wrapper is only scrollport-wide, so the grid tracks
            (which overflow it horizontally) would paint beyond the wrapper's
            box — the header's bg-muted and the row borders visibly stop
            mid-table at the scrollport edge. An explicit pixel width is used
            instead of w-max because max-content sizing would blow the 1fr
            date tracks up to their content width. min-w-full lets the fr
            tracks stretch back out when the columns don't fill the card. */}
        <div className="min-w-full" style={{ width: gridMinWidth }}>
          <div
            className={cn(
              'grid',
              'border-b border-border bg-muted py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
            )}
            style={{ gridTemplateColumns: gridTemplateCols }}
          >
            {/* No grid gap: the frozen columns' sticky offsets must exactly
                equal the preceding tracks' widths — any gap would open a
                see-through slit between them while scrolling. Cell padding
                inside the cells provides the breathing room instead. */}
            {/* NO items-center here: grid items must stretch to the full row
                height — with items-center each cell shrinks to its content
                (a one-line header = ~17px strip), and the taller two-line
                date headers scrolled underneath poke out above/below the
                frozen cells' background. Vertical centering is done inside
                each cell instead. */}
            {/* Frozen context columns: fully opaque + above the data rows, or
                scrolled date columns would show through them. */}
            <span className="sticky left-0 z-20 flex items-center bg-muted pl-4">
              {t('colBiomarkerReference')}
            </span>
            <span
              className="sticky z-20 flex items-center bg-muted text-left"
              style={{ left: NAME_COL_PX }}
            >
              {t('colTrend')}
            </span>
            {shownDates.map((date, i) => {
              const { day, year } = splitDateLabel(date.label)
              const isLatest = i === shownDates.length - 1
              // The "(Latest)" word is dropped from the header line (it
              // overflowed the column in longer locales); the newest column
              // is rightmost by definition and the day label keeps the
              // primary-color cue. Full label + marker stay in the tooltip.
              const full = `${date.label}${date.sub ? ` ${date.sub}` : ''}${isLatest ? ` ${t('latest')}` : ''}`
              const secondLine = date.sub ?? (year ? `’${year.slice(2)}` : null)
              return (
                <span
                  key={`${date.label}-${i}`}
                  className="flex flex-col items-end justify-center text-right leading-tight"
                  title={full}
                >
                  <span
                    className={cn(
                      'block whitespace-nowrap text-[10px]',
                      isLatest && 'text-primary',
                    )}
                  >
                    {day}
                  </span>
                  {secondLine && (
                    <span className="block whitespace-nowrap text-[9px] font-medium text-muted-foreground/60">
                      {secondLine}
                    </span>
                  )}
                </span>
              )
            })}
            <span aria-hidden className="pr-4" />
          </div>

          {filtered.map((cat) => (
            <div key={cat.category}>
              {/* Category band uses the SAME grid template as the rows: a
                  plain block would be scrollport-width only, leaving the
                  band's background short of the scrolled columns at deep
                  scroll. The label cell is sticky so the category name stays
                  pinned over the frozen name column while dates scroll
                  under the band. */}
              <div
                className="grid border-b border-border"
                style={{ gridTemplateColumns: gridTemplateCols }}
              >
                <span className="sticky left-0 z-10 bg-secondary py-2 pl-4 text-xs font-bold uppercase tracking-wide text-secondary-foreground">
                  {cat.category}
                </span>
                <span className="bg-secondary" />
                {shownDates.map((_, i) => (
                  <span key={i} className="bg-secondary" />
                ))}
                <span className="bg-secondary pr-4" />
              </div>
              {cat.rows.map((row) => {
                const bioResults = biomarkers.filter((b) => b.definition.id === row.id)
                const qual = isQualitative(row.reference)
                const history = bioResults
                  .map((b) => {
                    const v = coerceChartValue(b.value, qual)
                    return v == null ? null : { value: v, status: b.status }
                  })
                  .filter((h) => h != null) as { value: number; status: string }[]
                const hasBio = bioResults.length > 0
                const bounds = chartReferenceBounds(row.reference)
                // Align the tail of the cells array with the shown date
                // window (cells are index-aligned with `dates`).
                const cells =
                  range === 'all'
                    ? row.cells
                    : row.cells.slice(-(shownDates.length))
                const referenceText = formatReference(row.reference, row.unit, { lang: locale })
                return (
                  <div
                    key={row.id}
                    role={hasBio ? 'button' : undefined}
                    tabIndex={hasBio ? 0 : undefined}
                    aria-disabled={hasBio ? undefined : true}
                    onClick={() => {
                      if (hasBio) {
                        router.push('/details?id=' + row.id + '&from=flowsheet')
                      }
                    }}
                    onKeyDown={(e) => {
                      if (hasBio) activateOnKey(e, () => router.push('/details?id=' + row.id + '&from=flowsheet'))
                    }}
                    className={cn(
                      'group grid',
                      GRID_COLS,
                      'border-b border-border py-2.5 text-sm transition-colors',
                      hasBio && 'cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none',
                    )}
                    style={{ gridTemplateColumns: gridTemplateCols }}
                  >
                    {/* Frozen name cell: solid background, carries the row
                        hover/focus tint itself so the highlight doesn't
                        "skip" the frozen columns while dates scroll under. */}
                    <div
                      className="sticky left-0 z-10 min-w-0 bg-card pl-4 pr-2 leading-tight transition-colors group-focus-visible:bg-muted/50 group-hover:bg-muted/50"
                      title={`${row.name} · ${row.original} — ${referenceText}`}
                    >
                      <p className="truncate font-semibold text-foreground">
                        {row.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground/70">
                        {row.original} · {referenceText}
                      </p>
                    </div>
                    <div
                      className="sticky z-10 bg-card transition-colors group-focus-visible:bg-muted/50 group-hover:bg-muted/50"
                      style={{ left: NAME_COL_PX }}
                    >
                      <Sparkline
                        id={row.id}
                        history={history}
                        refMin={bounds?.low ?? undefined}
                        refMax={bounds?.high ?? undefined}
                      />
                    </div>
                    {cells.map((cell, i) => (
                      <Cell key={i} cell={cell} />
                    ))}
                    {hasBio ? (
                      <span className="flex items-center justify-end pr-4 text-muted-foreground transition-colors group-hover:text-foreground">
                        <ChevronRight className="size-4" />
                      </span>
                    ) : (
                      <span className="pr-4" />
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {filtered.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {query
                ? t('emptySearch', { query })
                : t('empty')}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
