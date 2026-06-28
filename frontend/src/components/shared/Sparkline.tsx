'use client'

import { ResponsiveContainer, LineChart, Line, YAxis } from 'recharts'

interface SparklineProps {
  id: string
  history: { value: number }[]
  refMin?: number
  refMax?: number
}

export function Sparkline({ id, history, refMin, refMax }: SparklineProps) {
  if (history.length === 0) return null

  const values = history.map((d) => d.value)
  const dataMax = Math.max(...values)
  const dataMin = Math.min(...values)
  const range = dataMax - dataMin || 1
  const hasRef = refMin !== undefined && refMax !== undefined
  const hasHigh = hasRef && dataMax > refMax
  const hasLow = hasRef && dataMin < refMin
  const isCompletelyNormal = hasRef && !hasHigh && !hasLow

  const upperOffset = hasHigh
    ? Math.max(0, Math.min(1, (dataMax - refMax) / range))
    : 0
  const lowerOffset = hasLow
    ? Math.max(0, Math.min(1, (dataMax - refMin) / range))
    : 1

  return (
    <div className="h-[30px] w-full max-w-[100px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={history} margin={{ top: 4, bottom: 4, left: 4, right: 4 }}>
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
                ? (props: { cx?: number; cy?: number; payload: { value: number; date: string } }) => {
                    const isOut =
                      props.payload.value > refMax ||
                      props.payload.value < refMin
                    if (isOut && props.cx != null && props.cy != null) {
                      return (
                        <circle
                          key={props.payload.date}
                          cx={props.cx}
                          cy={props.cy}
                          r={2.5}
                          fill="#ef4444"
                          stroke="none"
                        />
                      )
                    }
                    return null
                  }
                : false
            }
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
