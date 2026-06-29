'use client'

import { useState, useMemo } from 'react'
import { Search } from 'lucide-react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceArea,
  Tooltip,
} from 'recharts'

import { cn, splitDateLabel } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { BiomarkerResult } from '@/lib/types'

const CLINICAL_PALETTE = [
  '#3b82f6',
  '#8b5cf6',
  '#f59e0b',
  '#10b981',
  '#f43f5e',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f97316',
  '#6366f1',
]

function CustomTooltip({ active, payload, label, biomarkers }: any) {
  if (active && payload && payload.length) {
    const { label: mainLabel, sub } = splitDateLabel(label)
    return (
      <div className="rounded-md border border-border bg-white p-3 shadow-lg">
        <p className="text-sm font-semibold">{mainLabel}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        {payload.filter((entry: any) => !entry.dataKey.startsWith('dash_')).map((entry: any) => {
          const name = entry.dataKey.replace('norm_', '')
          const raw = entry.payload[`raw_${name}`]
          const b = biomarkers.find((x: BiomarkerResult) => x.id === name)
          return (
            <div
              key={entry.dataKey}
              className="flex items-center gap-2 text-sm"
              style={{ color: entry.color }}
            >
              <span
                className="size-3 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span>{b?.definition.name_en ?? name}:</span>
              <span className="font-bold">{raw}</span>
            </div>
          )
        })}
      </div>
    )
  }
  return null
}

export function CorrelationChart({ biomarkers: allBiomarkers }: { biomarkers: BiomarkerResult[] }) {
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([
    'ldl',
    'trig',
  ])

  const colorMap = useMemo(() => {
    const map: Record<string, string> = {}
    selectedIds.forEach((id, i) => {
      map[id] = CLINICAL_PALETTE[i % CLINICAL_PALETTE.length]
    })
    return map
  }, [selectedIds])

  const filteredBiomarkers = useMemo(() => {
    const q = query.trim().toLowerCase()
    const available = allBiomarkers.filter((b) => b.history?.length)
    if (!q) return available
    return available.filter(
      (b) =>
        b.definition.name_en.toLowerCase().includes(q) ||
        b.definition.name_ru.toLowerCase().includes(q),
    )
  }, [query, allBiomarkers])

  const toggleBiomarker = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const chartData = useMemo(() => {
    const selected = allBiomarkers.filter(
      (b) => selectedIds.includes(b.id) && b.history?.length,
    )
    if (selected.length === 0) return []

    const dateSet = new Set<string>()
    selected.forEach((b) => {
      b.history!.forEach((r) => dateSet.add(r.date))
      dateSet.add(b.date)
    })
    const dates = Array.from(dateSet).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    )

    const data = dates.map((date) => {
      const entry: Record<string, number | string | null> = { date }
      selected.forEach((b) => {
        const reading =
          b.history!.find((r) => r.date === date) ??
          (b.date === date ? { date: b.date, value: b.value, status: b.status } : undefined)
        if (reading) {
          const range = b.definition.range_max - b.definition.range_min || 1
          entry[`norm_${b.id}`] =
            ((reading.value - b.definition.range_min) / range) * 100
          entry[`raw_${b.id}`] = reading.value
        } else {
          entry[`norm_${b.id}`] = null
          entry[`raw_${b.id}`] = null
        }
        entry[`dash_${b.id}`] = null
      })
      return entry
    })

    selected.forEach((b) => {
      const dataKey = `norm_${b.id}`
      const dashKey = `dash_${b.id}`
      let prevIdx = -1
      data.forEach((row, i) => {
        if (row[dataKey] !== null) {
          if (prevIdx === -1 && i > 0) {
            data[0][dashKey] = row[dataKey] as number
            data[i][dashKey] = row[dataKey] as number
          }
          if (prevIdx >= 0 && prevIdx < i - 1) {
            data[prevIdx][dashKey] = data[prevIdx][dataKey] as number
            data[i][dashKey] = row[dataKey] as number
          }
          prevIdx = i
        }
      })
      if (prevIdx >= 0 && prevIdx < data.length - 1) {
        data[prevIdx][dashKey] = data[prevIdx][dataKey] as number
        data[data.length - 1][dashKey] = data[prevIdx][dataKey] as number
      }
    })

    return data
  }, [selectedIds, allBiomarkers])

  return (
    <div className="grid grid-cols-[300px_1fr] gap-6">
      <Card className="border-border">
        <div className="border-b border-border p-4">
          <h3 className="mb-1 text-sm font-semibold text-foreground">
            Select Biomarkers
          </h3>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              className="pl-8"
            />
          </div>
        </div>
        <div className="max-h-[500px] space-y-0.5 overflow-y-auto p-2">
          {filteredBiomarkers.map((b) => {
            const isSelected = selectedIds.includes(b.id)
            return (
              <label
                key={b.id}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-muted/40',
                  isSelected && 'bg-muted/20',
                )}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleBiomarker(b.id)}
                  className="accent-primary"
                />
                <span className="flex-1 truncate text-foreground">
                  {b.definition.name_en}
                </span>
                {isSelected && (
                  <span
                    className="size-3 shrink-0 rounded-full"
                    style={{ backgroundColor: colorMap[b.id] }}
                  />
                )}
              </label>
            )
          })}
        </div>
      </Card>

      <Card className="min-h-[500px] border-border">
        <div className="border-b border-border p-4">
          <h2 className="text-base font-semibold text-foreground">
            Biomarker Correlation Dynamics
          </h2>
          <p className="text-xs text-muted-foreground">
            Comparing normalized trends across selected biomarkers
          </p>
        </div>
        <div className="p-4">
          {chartData.length > 0 && selectedIds.length > 0 ? (
            <ResponsiveContainer width="100%" height={450}>
              <LineChart
                data={chartData}
                margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
              >
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={{ stroke: '#d4d4d8' }}
                  padding={{ left: 20, right: 20 }}
                  tick={({ x, y, payload }: any) => {
                    const { label, sub } = splitDateLabel(payload.value)
                    return (
                      <g transform={`translate(${x},${y})`}>
                        <text x={0} y={0} dy={12} textAnchor="middle" fill="#71717a" fontSize={11}>
                          {label}
                        </text>
                        {sub && (
                          <text x={0} y={0} dy={24} textAnchor="middle" fill="#a1a1aa" fontSize={9}>
                            {sub}
                          </text>
                        )}
                      </g>
                    )
                  }}
                />
                <YAxis hide domain={[-20, 120]} />
                <ReferenceArea
                  y1={0}
                  y2={100}
                  fill="#22c55e"
                  fillOpacity={0.05}
                />
                <Tooltip content={<CustomTooltip biomarkers={allBiomarkers} />} />
                {selectedIds.flatMap((id) => [
                  <Line
                    key={`${id}-solid`}
                    type="monotone"
                    dataKey={`norm_${id}`}
                    stroke={colorMap[id]}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 5, fill: colorMap[id] }}
                  />,
                  <Line
                    key={`${id}-dash`}
                    type="linear"
                    dataKey={`dash_${id}`}
                    stroke={colorMap[id]}
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    dot={false}
                    activeDot={false}
                    connectNulls={true}
                  />,
                ])}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[450px] items-center justify-center text-sm text-muted-foreground">
              Select at least one biomarker to display the correlation chart.
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
