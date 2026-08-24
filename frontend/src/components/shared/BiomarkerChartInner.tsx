'use client'

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type XAxisTickContentProps,
} from 'recharts'

import type { BiomarkerResult, Reading } from '@/lib/types'
import { sortReadingsByDate, splitDateLabel } from '@/lib/utils'
import { intervalBounds, isQualitative, qualitativeToNumber } from '@/lib/reference'

interface BiomarkerChartProps {
  biomarker: BiomarkerResult
  data?: Reading[]
  height?: number
  compact?: boolean
}

export default function BiomarkerChartInner({
  biomarker,
  data: dataProp,
  height = 250,
  compact = false,
}: BiomarkerChartProps) {
  const rawData = dataProp ?? [
    ...(biomarker.history ?? []),
    { date: biomarker.date, value: biomarker.value, status: biomarker.status },
  ]
  const effRef = biomarker.reference ?? biomarker.definition.reference
  const qual = isQualitative(effRef)
  // Recharts plots points in array order (categorical x-axis), so the series
  // must be chronological. Callers may hand over a series whose "current"
  // reading is a mid-series event promoted by biomarkersAtDate; sort here as
  // the single choke point so the x-axis is always oldest → newest.
  const data = sortReadingsByDate(
    rawData
      .map((d) => {
        if (typeof d.value === 'number' && Number.isFinite(d.value)) return { ...d, value: d.value as number }
        if (qual) {
          const qn = qualitativeToNumber(d.value)
          if (qn != null) return { ...d, value: qn }
        }
        return null
      })
      .filter((d) => d != null),
  ) as { date: string; value: number; status: string }[]
  const numericValues = data.map((d) => d.value)
  const bounds = qual ? { low: 0, high: 1 } : intervalBounds(effRef)
  const rm = bounds?.high ?? null
  const dataMax = rm != null ? Math.max(...numericValues, rm) : (numericValues.length > 0 ? Math.max(...numericValues) : 0)
  const yMax = rm != null ? Math.max(dataMax, rm * 1.2) : (numericValues.length > 0 ? dataMax * 1.2 : 1)

  // Reference band: anchored to the visible plot area so partial references
  // (e.g. upper-only "≤ 0.7" or lower-only "≥ 4") still show the normal zone.
  // Qualitative refs are excluded.
  const bandY1 = !qual && bounds?.low != null ? bounds.low : null
  const bandY2 = !qual && bounds?.high != null ? bounds.high : null
  const bandY1Final = bandY1 != null ? bandY1 : 0
  const bandY2Final =
    bandY2 != null
      ? bandY2
      : bandY1 != null
        ? Math.ceil(yMax)
        : null
  const hasBand = !qual && bandY2Final != null && bandY1Final !== bandY2Final

  if (numericValues.length === 0) {
    return (
      <div className="flex w-full items-center justify-center text-xs text-muted-foreground" style={{ height }}>
        {qual ? 'No qualitative readings to chart' : 'No numeric readings to chart'}
      </div>
    )
  }

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={compact ? { top: 4, right: 8, bottom: 0, left: -4 } : { top: 12, right: 16, bottom: 4, left: -8 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#d4d4d8"
            vertical={false}
          />
          {hasBand && (
            <ReferenceArea
              y1={bandY1Final}
              y2={bandY2Final}
              fill="#22c55e"
              fillOpacity={0.06}
            />
          )}
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={{ stroke: '#d4d4d8' }}
            tick={(tickProps: XAxisTickContentProps) => {
              const { label, sub } = splitDateLabel(String(tickProps.payload.value))
              const fs = compact ? 9 : 11
              const subFs = compact ? 8 : 9
              const dy1 = compact ? 10 : 12
              const dy2 = compact ? 20 : 24
              return (
                <g transform={`translate(${tickProps.x},${tickProps.y})`}>
                  <text x={0} y={0} dy={dy1} textAnchor="middle" fill="#71717a" fontSize={fs}>
                    {label}
                  </text>
                  {sub && (
                    <text x={0} y={0} dy={dy2} textAnchor="middle" fill="#a1a1aa" fontSize={subFs}>
                      {sub}
                    </text>
                  )}
                </g>
              )
            }}
          />
          <YAxis
            domain={[0, Math.ceil(yMax)]}
            tick={{ fontSize: compact ? 9 : 11, fill: '#71717a' }}
            tickLine={false}
            axisLine={false}
            width={compact ? 28 : 40}
          />
          <Tooltip
            cursor={{ stroke: '#d4d4d8', strokeWidth: 1 }}
            contentStyle={{
              borderRadius: 8,
              border: '1px solid #d4d4d8',
              fontSize: compact ? 11 : 12,
              boxShadow: '0 4px 12px rgb(0 0 0 / 0.06)',
            }}
            labelStyle={{ color: '#71717a', fontWeight: 500 }}
            labelFormatter={(label) => {
              const { label: mainLabel, sub } = splitDateLabel(String(label))
              return sub ? (
                <>
                  <span>{mainLabel}</span>
                  <span style={{ fontSize: '0.75em', color: '#a1a1aa' }}> — {sub}</span>
                </>
              ) : (
                mainLabel
              )
            }}
            formatter={(value) => [`${value ?? ''} ${biomarker.definition.unit}`, 'Result']}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#3b82f6"
            strokeWidth={compact ? 2 : 2.5}
            dot={(props: { cx?: number; cy?: number; payload: { status?: string } }) => {
              if (props.cx == null || props.cy == null) return null
              const abnormal = props.payload.status && props.payload.status !== 'normal'
              const color = abnormal ? '#ef4444' : '#3b82f6'
              const r = compact ? 3 : 4
              return (
                <circle key={`dot-${props.cx}-${props.cy}`} cx={props.cx} cy={props.cy} r={r}
                  fill="#fff" stroke={color} strokeWidth={compact ? 1.5 : 2} />
              )
            }}
            activeDot={(props: { cx?: number; cy?: number; payload: { status?: string } }) => {
              if (props.cx == null || props.cy == null) return null
              const abnormal = props.payload.status && props.payload.status !== 'normal'
              const color = abnormal ? '#ef4444' : '#3b82f6'
              return (
                <circle key={`active-${props.cx}-${props.cy}`} cx={props.cx} cy={props.cy}
                  r={compact ? 5 : 6} fill={color} stroke="none" />
              )
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
