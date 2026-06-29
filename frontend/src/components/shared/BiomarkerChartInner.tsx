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
} from 'recharts'

import type { BiomarkerResult, Reading } from '@/lib/types'
import { splitDateLabel } from '@/lib/utils'

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
  const data = dataProp ?? biomarker.history ?? []
  const values = data.map((d) => d.value)
  const dataMax = Math.max(...values, biomarker.definition.range_max)
  const yMax = Math.min(dataMax, biomarker.definition.range_max * 1.4)

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
          <ReferenceArea
            y1={biomarker.definition.range_min}
            y2={biomarker.definition.range_max}
            fill="#22c55e"
            fillOpacity={0.06}
          />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={{ stroke: '#d4d4d8' }}
            tick={({ x, y, payload }: any) => {
              const { label, sub } = splitDateLabel(payload.value)
              const fs = compact ? 9 : 11
              const subFs = compact ? 8 : 9
              const dy1 = compact ? 10 : 12
              const dy2 = compact ? 20 : 24
              return (
                <g transform={`translate(${x},${y})`}>
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
            labelFormatter={(label: any) => {
              const { label: mainLabel, sub } = splitDateLabel(String(label))
              return sub ? (
                <div>
                  <div>{mainLabel}</div>
                  <div style={{ fontSize: '0.75em', color: '#a1a1aa' }}>{sub}</div>
                </div>
              ) : (
                mainLabel
              )
            }}
            formatter={(value: number) => [`${value} ${biomarker.definition.unit}`, 'Result']}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#3b82f6"
            strokeWidth={compact ? 2 : 2.5}
            dot={{
              r: compact ? 3 : 4,
              fill: '#fff',
              stroke: '#3b82f6',
              strokeWidth: compact ? 1.5 : 2,
            }}
            activeDot={{ r: compact ? 5 : 6, fill: '#3b82f6' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
