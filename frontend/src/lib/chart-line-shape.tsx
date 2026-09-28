import { Curve, type CurveProps } from 'recharts'

import { DAY, LONG_GAP_DAYS } from './chart-series'
import { readingEpoch } from './utils'

/**
 * The one chart helper that needs recharts at RUNTIME (`Curve`).
 *
 * Split out of `lib/chart-series.tsx`, which the flowsheet matrix imports for
 * its pure helpers (`coerceChartValue`, `chartReferenceBounds`). A runtime
 * `Curve` import there put the whole ~350 KB recharts library in the first
 * paint of every page that renders the matrix — including the public shared
 * record, which a stranger opens on a phone. Only the two real chart
 * components (the biomarker chart and the correlation chart) import this.
 */

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
