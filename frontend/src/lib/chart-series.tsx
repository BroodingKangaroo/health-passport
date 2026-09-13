import { Curve, type CurveProps } from 'recharts'
import type { XAxisTickContentProps } from 'recharts'

import { intervalBounds, isQualitative, qualitativeToNumber } from './reference'
import { readingEpoch, splitDateLabel } from './utils'
import type { Reference } from './types'

/**
 * Shared chart-series helpers (ISSUES.md #71): value coercion, reference-band
 * derivation, and the two-line date tick renderer were previously implemented
 * 2-3x across BiomarkerChartInner, flowsheet-matrix, and correlation-chart.
 */

/**
 * Coerce a reading value into a plottable number. Finite numbers pass
 * through; for a QUALITATIVE reference the canonical qualitative strings map
 * to 0/1 (qualitativeToNumber); anything else is not plottable (null).
 */
export function coerceChartValue(
  value: string | number | null | undefined,
  qualitative: boolean,
): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!qualitative) return null
  return qualitativeToNumber(value)
}

/**
 * Reference-band bounds for a chart: a qualitative reference spans the
 * 0..1 axis used by qualitativeToNumber; an interval reference yields its
 * own bounds; null otherwise.
 */
export function chartReferenceBounds(
  ref: Reference | null | undefined,
): { low: number | null; high: number | null } | null {
  return isQualitative(ref) ? { low: 0, high: 1 } : intervalBounds(ref)
}

const DAY = 86_400_000
// Minimum mapped cost between two DISTINCT timestamps on the warped axis.
// asinh makes a few-hours gap nearly free, which would stack genuinely
// distinct points; one unit keeps a visible slot for every distinct reading.
const MIN_STEP = 1
// A distinct gap longer than this reads as an absent period, not a trend step:
// its segment is dashed and annotated with the elapsed months.
const LONG_GAP_DAYS = 60
// In the warped axis a gap costing less than a fraction of the total span will
// not fit a full date label; those ticks drop to month granularity so thinning
// keeps more of them. (Width-independent: ~8 full labels fit across the axis.)
const DENSE_TICK_FRACTION = 1 / 8

export type AxisMode = 'even' | 'time'

export interface TickInfo {
  date: string
  monthOnly: boolean
}

export interface TimeGap {
  fromX: number
  toX: number
  fromEpoch: number
  toEpoch: number
  months: number
}

export interface TimeAxis<T extends { date: string }> {
  rows: (T & { t: number })[]
  ticks: number[]
  domain: [number, number]
  /** Mapped tick x -> the reading date it represents (never an epoch). */
  tickDates: Map<number, TickInfo>
  /** Consecutive-reading gaps longer than LONG_GAP_DAYS, mapped endpoints. */
  longGaps: TimeGap[]
}

function gapCost(gapMs: number): number {
  return Math.max(Math.asinh(gapMs / DAY), MIN_STEP)
}

/**
 * Turn date-keyed rows into a recharts NUMERIC x axis. Both modes are
 * order-preserving and place ticks at real readings (never at "nice" calendar
 * boundaries):
 *
 * - `time` (default): a warped GAP-COST axis — each wait contributes
 *   `max(asinh(gap/1day), 1)` units, so a five-year-old isolated reading costs
 *   ~8 units instead of dominating the plot, while 2-day and 1-month gaps stay
 *   clearly different (≈1.4 vs ≈4.1 units). Rows sharing an identical
 *   timestamp are nudged apart by a bounded offset computed in mapped space.
 * - `even`: one slot per row (`x_i = i`), the original equidistant look.
 *
 * `tickDates` maps each tick x to its reading date plus label granularity
 * (`monthOnly` on dense sub-regions) and `longGaps` carries the >60-day gaps
 * for dashed segment rendering. `domain` pads the extremes in mapped units and
 * never collapses to a zero span (which would make the d3 scale emit NaN).
 */
export function buildTimeAxis<T extends { date: string }>(
  rows: readonly T[],
  opts: { mode?: AxisMode; nudge?: boolean } = {},
): TimeAxis<T> {
  if (rows.length === 0) {
    return { rows: [], ticks: [], domain: [0, 1], tickDates: new Map(), longGaps: [] }
  }
  const mode = opts.mode ?? 'time'
  const nudge = opts.nudge ?? true

  const epochs = rows.map((row) => readingEpoch(row.date))
  const groups = new Map<number, number[]>()
  epochs.forEach((t, i) => {
    const list = groups.get(t)
    if (list) list.push(i)
    else groups.set(t, [i])
  })
  const distinct = [...groups.keys()].sort((a, b) => a - b)
  const firstRowOf = (t: number) => groups.get(t)![0]

  const baseX = new Array<number>(rows.length)
  if (mode === 'even') {
    rows.forEach((_, i) => {
      baseX[i] = i
    })
  } else {
    const xForEpoch = new Map<number, number>()
    let x = 0
    distinct.forEach((t, i) => {
      if (i > 0) x += gapCost(t - distinct[i - 1])
      xForEpoch.set(t, x)
    })
    epochs.forEach((t, i) => {
      baseX[i] = xForEpoch.get(t)!
    })
  }

  const offsets = baseX.map(() => 0)
  if (mode === 'time' && nudge) {
    distinct.forEach((t, di) => {
      const members = groups.get(t)!
      if (members.length < 2) return
      const x = baseX[members[0]]
      const prevX = di > 0 ? baseX[firstRowOf(distinct[di - 1])] : Number.NaN
      const nextX =
        di < distinct.length - 1 ? baseX[firstRowOf(distinct[di + 1])] : Number.NaN
      const prevGap = Number.isNaN(prevX) ? Infinity : x - prevX
      const nextGap = Number.isNaN(nextX) ? Infinity : nextX - x
      const bound = Math.min(prevGap, nextGap)
      const safeBound = Number.isFinite(bound) ? bound : MIN_STEP * (members.length + 1)
      // Extreme offset is (n - 1) / 2 * step, i.e. under half the mapped gap
      // to the nearest distinct reading on either side.
      const step = (safeBound * 0.8) / (members.length - 1)
      members.forEach((rowIndex, rank) => {
        offsets[rowIndex] = (rank - (members.length - 1) / 2) * step
      })
    })
  }
  const times = baseX.map((x, i) => x + offsets[i])

  const tickDates = new Map<number, TickInfo>()
  let ticks: number[]
  if (mode === 'even') {
    ticks = times.slice()
    rows.forEach((row, i) => {
      tickDates.set(times[i], { date: row.date, monthOnly: false })
    })
  } else {
    const entries = distinct.map((t) => ({
      x: baseX[firstRowOf(t)],
      date: rows[firstRowOf(t)].date,
    }))
    entries.sort((a, b) => a.x - b.x)
    ticks = entries.map((entry) => entry.x)
    const span = entries.length > 1 ? entries[entries.length - 1].x - entries[0].x : 0
    entries.forEach((entry, i) => {
      const prevDist = i > 0 ? entry.x - entries[i - 1].x : Infinity
      const nextDist = i < entries.length - 1 ? entries[i + 1].x - entry.x : Infinity
      const monthOnly = Math.min(prevDist, nextDist) < span * DENSE_TICK_FRACTION
      tickDates.set(entry.x, { date: entry.date, monthOnly })
    })
  }

  const longGaps: TimeGap[] = []
  for (let i = 1; i < rows.length; i++) {
    const days = (epochs[i] - epochs[i - 1]) / DAY
    if (days > LONG_GAP_DAYS) {
      longGaps.push({
        fromX: times[i - 1],
        toX: times[i],
        fromEpoch: epochs[i - 1],
        toEpoch: epochs[i],
        months: Math.max(1, Math.round(days / 30.44)),
      })
    }
  }

  const min = Math.min(...times)
  const max = Math.max(...times)
  const span = max - min
  const pad = span > 0 ? span * 0.03 : MIN_STEP
  return {
    rows: rows.map((row, i) => ({ ...row, t: times[i] })),
    ticks,
    domain: [min - pad, max + pad],
    tickDates,
    longGaps,
  }
}

/**
 * Date parts for an x value that may be an epoch (legacy numeric axis) or a
 * raw date string (categorical/legacy callers). New mapped axes must resolve
 * through `tickDates` instead — a mapped x is NOT an epoch.
 */
export function axisDateLabel(
  value: number | string,
  locale = 'en-US',
): { label: string; sub?: string } {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return splitDateLabel(new Date(value).toISOString(), locale)
  }
  return splitDateLabel(String(value), locale)
}

/** Label parts for a resolved tick: full date (+time) or month only. */
export function tickLabel(info: TickInfo, locale = 'en-US'): { label: string; sub?: string } {
  if (info.monthOnly) {
    const d = new Date(info.date)
    if (!Number.isNaN(d.getTime())) {
      return { label: d.toLocaleDateString(locale, { month: 'short', year: 'numeric' }) }
    }
    return { label: info.date }
  }
  return splitDateLabel(info.date, locale)
}

export type TickResolver = (value: number | string) => TickInfo | undefined

/**
 * Main tick label (no time sub-line) handed to recharts as `tickFormatter`.
 * recharts measures this string to decide which ticks fit. When a resolver is
 * given, an unresolved tick returns an empty label — mapped x values must
 * never silently format as a 1970 epoch.
 */
export function dateTickFormatter(
  locale: string,
  resolve?: TickResolver,
): (value: number | string) => string {
  return (value) => {
    if (resolve) {
      const info = resolve(value)
      return info ? tickLabel(info, locale).label : ''
    }
    return axisDateLabel(value, locale).label
  }
}

/**
 * Two-line date tick renderer for recharts XAxis: the main date label plus a
 * smaller sub-label (time) beneath it. `compact` shrinks the fonts/offsets
 * for the small sparkline-style charts. The main <text> keeps recharts'
 * `recharts-cartesian-axis-tick-value` class (passed through in tickProps) so
 * tick-thinning measurement uses the real font size, not the SVG default.
 */
export function dateTickRenderer(
  locale: string,
  opts?: { compact?: boolean; resolve?: TickResolver },
) {
  const compact = opts?.compact ?? false
  const resolve = opts?.resolve
  // Named function declaration so the React lint rule sees a display name.
  function DateTick(tickProps: XAxisTickContentProps) {
    const value = tickProps.payload.value as number | string
    const info = resolve?.(value)
    if (resolve && !info) return null
    const { label, sub } = info ? tickLabel(info, locale) : axisDateLabel(value, locale)
    const fs = compact ? 9 : 11
    const subFs = compact ? 8 : 9
    const dy1 = compact ? 10 : 12
    const dy2 = compact ? 20 : 24
    return (
      <g transform={`translate(${tickProps.x},${tickProps.y})`}>
        <text
          className={tickProps.className}
          x={0}
          y={0}
          dy={dy1}
          textAnchor="middle"
          fill="#71717a"
          fontSize={fs}
        >
          {label}
        </text>
        {sub && (
          <text x={0} y={0} dy={dy2} textAnchor="middle" fill="#a1a1aa" fontSize={subFs}>
            {sub}
          </text>
        )}
      </g>
    )
  }
  return DateTick
}

type LineShapeProps = CurveProps & {
  animationElapsedTime?: unknown
  isAnimating?: unknown
  isEntrance?: unknown
  visibleLength?: unknown
}

const SHAPE_STRIPPED_PROPS = new Set([
  'points',
  'pathRef',
  'animationElapsedTime',
  'isAnimating',
  'isEntrance',
  'visibleLength',
  'className',
])

/**
 * Line `shape` factory for a warped axis: draws the curve in solid runs split
 * wherever a series' consecutive readings are more than `LONG_GAP_DAYS` apart,
 * with a dashed bridge plus an elapsed-months label across each such absence
 * so a multi-year leg is not read as a smooth trend. The elapsed time is
 * measured per series, not from the axis' `longGaps`: a sparse series can skip
 * several union rows (other series' dates) and still span a long absence.
 */
export function gapAwareLineShape(opts: {
  gapLabel: (months: number) => string
  compact?: boolean
}) {
  // Named function declaration so the React lint rule sees a display name.
  function GapAwareLine(props: LineShapeProps) {
    type ShapePoint = { x: number | null; y: number | null; payload?: unknown }
    const points = ((props.points ?? []) as ShapePoint[]).filter(
      (p): p is ShapePoint & { x: number; y: number } =>
        typeof p.x === 'number' && typeof p.y === 'number',
    )
    if (points.length < 2) return null
    const pointEpoch = (point: ShapePoint) => {
      const date = (point.payload as { date?: string } | undefined)?.date
      return typeof date === 'string' ? readingEpoch(date) : Number.NaN
    }
    const runs: (ShapePoint & { x: number; y: number })[][] = []
    const bridges: {
      a: ShapePoint & { x: number; y: number }
      b: ShapePoint & { x: number; y: number }
      months: number
    }[] = []
    let current = [points[0]]
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]
      const next = points[i]
      // Dash whatever elapsed time the reader actually sees missing, not just
      // the axis' own consecutive-row gaps: a sparse series can skip several
      // union rows (other series' dates) and still span a long absence.
      const elapsedDays = (pointEpoch(next) - pointEpoch(prev)) / DAY
      if (Number.isFinite(elapsedDays) && elapsedDays > LONG_GAP_DAYS) {
        bridges.push({
          a: prev,
          b: next,
          months: Math.max(1, Math.round(elapsedDays / 30.44)),
        })
        runs.push(current)
        current = [next]
      } else {
        current.push(next)
      }
    }
    runs.push(current)

    const className = props.className
    const curveProps = Object.fromEntries(
      Object.entries(props).filter(([key]) => !SHAPE_STRIPPED_PROPS.has(key)),
    ) as CurveProps

    const fs = opts.compact ? 8 : 10
    return (
      <g>
        {runs.map((run, i) =>
          run.length > 1 ? (
            <Curve
              key={`run-${i}`}
              {...curveProps}
              className={i === 0 ? className : undefined}
              points={run}
            />
          ) : null,
        )}
        {bridges.map((bridge, i) => (
          <g key={`gap-${i}`}>
            <Curve {...curveProps} points={[bridge.a, bridge.b]} strokeDasharray="4 4" />
            <text
              x={(bridge.a.x + bridge.b.x) / 2}
              y={(bridge.a.y + bridge.b.y) / 2 - (opts.compact ? 6 : 8)}
              textAnchor="middle"
              fill="#71717a"
              fontSize={fs}
            >
              {opts.gapLabel(bridge.months)}
            </text>
          </g>
        ))}
      </g>
    )
  }
  return GapAwareLine
}
