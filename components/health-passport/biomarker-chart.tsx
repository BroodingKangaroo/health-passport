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

import type { Biomarker, Reading } from './data'

interface BiomarkerChartProps {
  biomarker: Biomarker
  data?: Reading[]
  height?: number
}

export function BiomarkerChart({ biomarker, data: dataProp, height = 250 }: BiomarkerChartProps) {
  const data = dataProp ?? biomarker.history ?? []
  const values = data.map((d) => d.value)
  const dataMax = Math.max(...values, biomarker.rangeMax)
  const yMax = Math.min(dataMax, biomarker.rangeMax * 1.4)

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: -8 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            vertical={false}
          />
          <ReferenceArea
            y1={biomarker.rangeMin}
            y2={biomarker.rangeMax}
            fill="var(--status-normal)"
            fillOpacity={0.06}
            stroke="var(--status-normal)"
            strokeOpacity={0.2}
            strokeDasharray="4 4"
          />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--border)' }}
            tickMargin={8}
          />
          <YAxis
            domain={[0, Math.ceil(yMax)]}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
            contentStyle={{
              borderRadius: 8,
              border: '1px solid var(--border)',
              fontSize: 12,
              boxShadow: '0 4px 12px rgb(0 0 0 / 0.06)',
            }}
            labelStyle={{ color: 'var(--muted-foreground)', fontWeight: 500 }}
            formatter={(value: number) => [`${value} ${biomarker.unit}`, 'Result']}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--primary)"
            strokeWidth={2.5}
            dot={{
              r: 4,
              fill: 'var(--card)',
              stroke: 'var(--primary)',
              strokeWidth: 2,
            }}
            activeDot={{ r: 6, fill: 'var(--primary)' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
