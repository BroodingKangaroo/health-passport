'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { intervalReference } from '@/lib/reference'
import type { Reference } from '@/lib/types'

// Editor for an interval reference. The four modes map to the structured
// reference: a two-sided interval, a one-sided upper (≤ high), a one-sided
// lower (≥ low), or no reference at all. Qualitative references are not
// authored here — they arise from non-numeric values during extraction/entry.
type RefType = 'interval' | 'lt' | 'gt' | 'none'

interface Props {
  value: Reference | null
  onChange: (ref: Reference | null) => void
}

function parseType(ref: Reference | null): { type: RefType; lo: string; hi: string } {
  if (!ref || ref.kind !== 'interval') return { type: 'none', lo: '', hi: '' }
  const lo = ref.low != null ? String(ref.low) : ''
  const hi = ref.high != null ? String(ref.high) : ''
  if (lo !== '' && hi !== '') return { type: 'interval', lo, hi }
  if (hi !== '') return { type: 'lt', lo: '', hi }
  if (lo !== '') return { type: 'gt', lo, hi: '' }
  return { type: 'none', lo: '', hi: '' }
}

function parseNumber(s: string): number | null {
  if (!s) return null
  const v = Number.parseFloat(s)
  return Number.isFinite(v) ? v : null
}

function buildReference(type: RefType, lo: string, hi: string): Reference | null {
  const low = parseNumber(lo)
  const high = parseNumber(hi)
  switch (type) {
    case 'interval':
      // A two-sided interval needs BOTH bounds to be numeric. If one is
      // missing OR non-numeric, emit nothing rather than a NaN bound —
      // that would render "NaN – 5" and, via JSON.stringify(NaN → null),
      // silently reshape the interval into one-sided on save
      // (ISSUES.md #64). (Use the < / > types for single-bound references.)
      if (low == null || high == null) return null
      return intervalReference(low, high)
    case 'lt':
      return high != null ? intervalReference(null, high) : null
    case 'gt':
      return low != null ? intervalReference(low, null) : null
    case 'none':
      return null
  }
}

export function ReferenceInput({ value, onChange }: Props) {
  const t = useTranslations('reference')
  const [initial] = useState(() => parseType(value))
  const [type, setType] = useState<RefType>(initial.type)
  const [loVal, setLoVal] = useState(initial.lo)
  const [hiVal, setHiVal] = useState(initial.hi)

  const emit = (t: RefType, lo: string, hi: string) => {
    onChange(buildReference(t, lo, hi))
  }

  const handleTypeChange = (t: RefType) => {
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
        onChange={(e) => handleTypeChange(e.target.value as RefType)}
        className="h-8 w-[88px] shrink-0 rounded-lg border border-input bg-background px-1.5 text-[11px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        <option value="interval">{t('interval')}</option>
        <option value="lt">≤</option>
        <option value="gt">≥</option>
        <option value="none">{t('none')}</option>
      </select>
      {type === 'interval' && (
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
          placeholder={t('placeholderMax')}
          onChange={(e) => handleHiChange(e.target.value)}
          className="h-8 w-[88px] rounded-lg border border-input bg-background px-1.5 text-[11px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
      )}
      {type === 'gt' && (
        <input
          value={loVal}
          placeholder={t('placeholderMin')}
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