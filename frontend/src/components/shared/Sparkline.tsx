'use client'

import { ResponsiveContainer, LineChart, Line, YAxis } from 'recharts'

interface SparklineProps {
  id: string
  history: { value: number; status?: string }[]
  refMin?: number
  refMax?: number
}

export function Sparkline({ id, history, refMin, refMax }: SparklineProps) {
  const numeric = history.filter((d) => typeof d.value === 'number' && Number.isFinite(d.value))
  if (numeric.length === 0) return null

  const values = numeric.map((d) => d.value as number)
  const dataMax = Math.max(...values)
  const dataMin = Math.min(...values)
  const range = dataMax - dataMin || 1
  const hasRef = refMin !== undefined || refMax !== undefined
  const safeRefMin = refMin !== undefined ? refMin : -Infinity
  const safeRefMax = refMax !== undefined ? refMax : Infinity
  const hasHigh = dataMax > safeRefMax
  const hasLow = dataMin < safeRefMin
  const isCompletelyNormal = hasRef && !hasHigh && !hasLow

  const upperOffset = hasHigh
    ? Math.max(0, Math.min(1, (dataMax - safeRefMax) / range))
    : 0
  const lowerOffset = hasLow
    ? Math.max(0, Math.min(1, (dataMax - safeRefMin) / range))
    : 1

  return (
    <div className="h-[30px] w-full max-w-[100px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={numeric} margin={{ top: 4, bottom: 4, left: 4, right: 4 }}>
          {hasRef && <YAxis domain={['dataMin', 'dataMax']} hide />}
          {hasRef && !isCompletelyNormal && (
            <defs>
              <linearGradient
                id={`sparkline-grad-${id}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                {hasHigh && (
                  <>
                    <stop offset="0%" stopColor="#ef4444" />
                    <stop offset={`${upperOffset * 100}%`} stopColor="#ef4444" />
                  </>
                )}
                <stop offset={`${upperOffset * 100}%`} stopColor="#3b82f6" />
                <stop offset={`${lowerOffset * 100}%`} stopColor="#3b82f6" />
                {hasLow && (
                  <>
                    <stop offset={`${lowerOffset * 100}%`} stopColor="#ef4444" />
                    <stop offset="100%" stopColor="#ef4444" />
                  </>
                )}
              </linearGradient>
            </defs>
          )}
          <Line
            type="monotone"
            dataKey="value"
            stroke={isCompletelyNormal || !hasRef ? '#3b82f6' : `url(#sparkline-grad-${id})`}
            strokeWidth={2}
            strokeLinecap="round"
            isAnimationActive={false}
            dot={
              hasRef
                ? (props: { cx?: number; cy?: number; payload: { value: number; status?: string } }) => {
                    if (props.cx == null || props.cy == null) return null
                    const abnormal = props.payload.status === 'high' || props.payload.status === 'low' || props.payload.status === 'abnormal'
                    return (
                      <circle
                        key={`dot-${props.cx}-${props.cy}`}
                        cx={props.cx}
                        cy={props.cy}
                        r={abnormal ? 3.5 : 2.5}
                        fill={abnormal ? '#ef4444' : '#3b82f6'}
                        stroke={abnormal ? '#ef4444' : '#3b82f6'}
                        strokeWidth={1.5}
                      />
                    )
                  }
                : false
            }
            activeDot={
              hasRef
                ? (props: { cx?: number; cy?: number; payload: { value: number; status?: string } }) => {
                    if (props.cx == null || props.cy == null) return null
                    const abnormal = props.payload.status === 'high' || props.payload.status === 'low' || props.payload.status === 'abnormal'
                    return (
                      <circle
                        key={`active-${props.cx}-${props.cy}`}
                        cx={props.cx}
                        cy={props.cy}
                        r={4}
                        fill={abnormal ? '#ef4444' : '#3b82f6'}
                        stroke="none"
                      />
                    )
                  }
                : false
            }
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
