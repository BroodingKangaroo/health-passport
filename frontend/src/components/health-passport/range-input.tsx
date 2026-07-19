'use client'

import { useEffect, useState } from 'react'

type RangeType = 'range' | 'lt' | 'gt' | 'none'

interface Props {
  value: string
  onChange: (val: string) => void
}

function parseType(value: string): {
  type: RangeType
  lo: string
  hi: string
} {
  const lt = value.match(/<\s*([\d.]+)/)
  if (lt) return { type: 'lt', lo: '', hi: lt[1] }
  const gt = value.match(/>\s*([\d.]+)/)
  if (gt) return { type: 'gt', lo: gt[1], hi: '' }
  const m = value.match(/([\d.]+)\s*[-–]?\s*([\d.]+)/)
  if (m) return { type: 'range', lo: m[1], hi: m[2] }
  return { type: 'none', lo: '', hi: '' }
}

function formatChange(type: RangeType, lo: string, hi: string): string {
  switch (type) {
    case 'range':
      // A two-sided range needs BOTH bounds. If only one is filled, emit
      // nothing rather than a broken "5–0" that would flag every value
      // as abnormal. (Use the < / > types for single-bound ranges.)
      if (!lo || !hi) return ''
      return `${lo}–${hi}`
    case 'lt':
      return hi ? `< ${hi}` : ''
    case 'gt':
      return lo ? `> ${lo}` : ''
    case 'none':
      return ''
  }
}

export function RangeInput({ value, onChange }: Props) {
  const [initialized, setInitialized] = useState(false)
  const [type, setType] = useState<RangeType>('none')
  const [loVal, setLoVal] = useState('')
  const [hiVal, setHiVal] = useState('')

  useEffect(() => {
    if (initialized) return
    const parsed = parseType(value)
    setType(parsed.type)
    setLoVal(parsed.lo)
    setHiVal(parsed.hi)
    setInitialized(true)
  }, [value, initialized])

  const emit = (t: RangeType, lo: string, hi: string) => {
    onChange(formatChange(t, lo, hi))
  }

  const handleTypeChange = (t: RangeType) => {
    setType(t)
    emit(t, loVal, hiVal)
  }

  const handleLoChange = (v: string) => {
    setLoVal(v)
    emit(type, v, hiVal)
  }

  const handleHiChange = (v: string) => {
    setHiVal(v)
    emit(type, loVal, v)
  }

  return (
    <div className="flex items-center gap-1">
      <select
        value={type}
        onChange={(e) => handleTypeChange(e.target.value as RangeType)}
        className="h-8 w-[88px] shrink-0 rounded-lg border border-input bg-background px-1.5 text-[11px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        <option value="range">Range</option>
        <option value="lt">&lt;</option>
        <option value="gt">&gt;</option>
        <option value="none">None</option>
      </select>
      {type === 'range' && (
        <div className="flex items-center gap-0.5">
          <input
            value={loVal}
            placeholder="0"
            onChange={(e) => handleLoChange(e.target.value)}
            className="h-8 w-[52px] rounded-lg border border-input bg-background px-1.5 text-[11px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          <span className="text-[11px] text-muted-foreground">–</span>
          <input
            value={hiVal}
            placeholder="0"
            onChange={(e) => handleHiChange(e.target.value)}
            className="h-8 w-[52px] rounded-lg border border-input bg-background px-1.5 text-[11px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        </div>
      )}
      {type === 'lt' && (
        <input
          value={hiVal}
          placeholder="max"
          onChange={(e) => handleHiChange(e.target.value)}
          className="h-8 w-[88px] rounded-lg border border-input bg-background px-1.5 text-[11px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      )}
      {type === 'gt' && (
        <input
          value={loVal}
          placeholder="min"
          onChange={(e) => handleLoChange(e.target.value)}
          className="h-8 w-[88px] rounded-lg border border-input bg-background px-1.5 text-[11px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      )}
      {type === 'none' && (
        <span className="text-[11px] text-muted-foreground/50">—</span>
      )}
    </div>
  )
}
