'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Search } from 'lucide-react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceArea,
  Tooltip,
  type TooltipContentProps,
} from 'recharts'

import { cn, splitDateLabel } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { intervalBounds, qualitativeToNumber } from '@/lib/reference'
import { isQualitative } from '@/lib/reference'
import { coerceChartValue, dateTickRenderer } from '@/lib/chart-series'
import { pairwiseCorrelations, type PairStats } from '@/lib/stats'
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

type TFunction = ReturnType<typeof useTranslations>

/** A biomarker is chartable when it has at least one reading (history or current). */
export function hasReadings(b: BiomarkerResult): boolean {
  return (b.history?.length ?? 0) > 0 || b.value != null
}

/**
 * Normalize a numeric value to a 0–100 scale relative to its reference:
 *   interval         -> (v - low) / (high - low) * 100   (100 = at the upper bound)
 *   one-sided high   -> v / high * 100                   (100 = at the bound)
 *   one-sided low    -> v / low * 100                    (100 = at the bound)
 *   exact (low=high) -> v / low * 100                    (100 = at the expected value)
 *   zero bound at 0  -> 0 when at the bound, 100 for any excess
 *                       (proportional scaling would divide by zero)
 *   qualitative/other-> v * 100 on a 0/1 scale
 */
export function normalizedValue(
  value: number,
  ref: BiomarkerResult['reference'],
): number | null {
  const bounds = intervalBounds(ref) ?? { low: 0, high: 1 }
  const { low, high } = bounds
  const scale = (v: number) => (Number.isFinite(v) ? v : null)
  if (low != null && high != null) {
    const range = high - low
    if (range === 0) {
      if (low === 0) return value === 0 ? 0 : 100
      return scale((value / low) * 100)
    }
    return scale(((value - low) / range) * 100)
  }
  if (high != null) {
    if (high === 0) return value === 0 ? 0 : 100
    return scale((value / high) * 100)
  }
  if (low != null) {
    if (low === 0) return value === 0 ? 0 : 100
    return scale((value / low) * 100)
  }
  return null
}

/**
 * Align a set of biomarkers on the union of their reading dates. Returns the
 * sorted dates, the raw values per biomarker (for tooltips), and per-biomarker
 * normalized series with one slot per date (null where the biomarker has no
 * reading) — the input shape for pairwise correlation.
 */
function buildAlignedSeries(biomarkers: BiomarkerResult[]) {
  const dates = new Set<string>()
  const byId: Record<string, Map<string, number | string | null>> = {}
  biomarkers.forEach((b) => {
    const pts = new Map<string, number | string | null>()
    const readings = [...(b.history ?? []), { date: b.date, value: b.value }]
    readings.forEach((r) => {
      if (r.value == null || pts.has(r.date)) return
      pts.set(r.date, r.value)
      dates.add(r.date)
    })
    byId[b.id] = pts
  })
  const sorted = Array.from(dates).sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime(),
  )
  const series: Record<string, Array<number | null>> = {}
  biomarkers.forEach((b) => {
    const ref = b.reference ?? b.definition.reference
    series[b.id] = sorted.map((d) => {
      const v = byId[b.id].get(d)
      if (v == null) return null
      const numericVal = coerceChartValue(v, isQualitative(ref))
      if (numericVal == null) return null
      return normalizedValue(numericVal, ref)
    })
  })
  return { dates: sorted, byId, series }
}

function CustomTooltip({
  active,
  payload,
  label,
  biomarkers,
}: Partial<TooltipContentProps> & { biomarkers: BiomarkerResult[] }) {
  const locale = useLocale()
  if (active && payload && payload.length) {
    const labelText = typeof label === 'string' ? label : String(label ?? '')
    const { label: mainLabel, sub } = splitDateLabel(labelText, locale)
    const visible = payload.filter((entry) => {
      if (typeof entry.dataKey !== 'string') return false
      if (entry.dataKey.startsWith('dash_')) return false
      const name = entry.dataKey.replace('norm_', '')
      return entry.payload[`raw_${name}`] != null
    })
    if (visible.length === 0) return null
    return (
      <div className="rounded-md border border-border bg-popover p-3 shadow-lg">
        <p className="text-sm font-semibold">{mainLabel}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        {visible.map((entry) => {
          const dataKey = String(entry.dataKey)
          const name = dataKey.replace('norm_', '')
          const raw = entry.payload[`raw_${name}`]
          const b = biomarkers.find((x: BiomarkerResult) => x.id === name)
          return (
            <div
              key={dataKey}
              className="flex items-center gap-2 text-sm"
              style={{ color: entry.color }}
            >
              <span
                className="size-3 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span>{b?.definition.names.en ?? name}:</span>
              <span className="font-bold">{raw}</span>
            </div>
          )
        })}
      </div>
    )
  }
  return null
}

/** Plain-language strength of a correlation coefficient (r in [-1, 1]). */
function strengthLabel(r: number, t: TFunction): string {
  const a = Math.abs(r)
  const direction = r >= 0 ? t('strength.positive') : t('strength.negative')
  if (a >= 0.7) {
    return t('strength.composed', {
      strength: t('strength.strong'),
      direction,
    })
  }
  if (a >= 0.4) {
    return t('strength.composed', {
      strength: t('strength.moderate'),
      direction,
    })
  }
  if (a >= 0.2) {
    return t('strength.composed', {
      strength: t('strength.weak'),
      direction,
    })
  }
  return t('strength.negligible')
}

/** Plain-language confidence, replacing raw p-value jargon. */
function confidenceLabel(n: number, p: number, t: TFunction): string {
  if (n < 3 || !Number.isFinite(p)) return t('confidence.tooFew')
  return p < 0.05 ? t('confidence.real') : t('confidence.chance')
}

function rColor(r: number): string {
  const a = Math.abs(r)
  if (a >= 0.7) return r >= 0 ? '#10b981' : '#f43f5e'
  if (a >= 0.4) return r >= 0 ? '#3b82f6' : '#f97316'
  return '#71717a'
}

function CorrelationStats({
  pairStats,
  selectedIds,
  biomarkers,
}: {
  pairStats: Record<string, PairStats>
  selectedIds: string[]
  biomarkers: BiomarkerResult[]
}) {
  const t = useTranslations('correlation')
  const nameOf = (id: string) =>
    biomarkers.find((b) => b.id === id)?.definition.names.en ?? id
  const entries = Object.entries(pairStats)

  if (selectedIds.length < 2) {
    return null
  }

  return (
    <div className="border-b border-border px-4 py-3">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('stats.heading')}
      </p>
      {entries.length > 0 ? (
        <div className="grid max-h-[200px] gap-1.5 overflow-y-auto pr-1 md:grid-cols-2 [scrollbar-width:thin]">
          {entries.map(([pairKey, s]) => {
            const [a, b] = pairKey.split('|')
            return (
              <div
                key={pairKey}
                className="rounded-md border border-border bg-muted/10 px-2.5 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-medium">
                    {nameOf(a)} × {nameOf(b)}
                  </span>
                  <span
                    className="shrink-0 text-[11px] font-semibold"
                    style={{ color: rColor(s.r) }}
                  >
                    r = {s.r.toFixed(2)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  <span
                    className="font-medium"
                    style={{ color: rColor(s.r) }}
                  >
                    {strengthLabel(s.r, t)}
                  </span>
                  {' · '}{t('readingsCount', { count: s.n })} · {confidenceLabel(s.n, s.p, t)}
                </p>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('stats.needPaired')}
        </p>
      )}
    </div>
  )
}

function TopCorrelatedPairs({
  pairs,
  biomarkers,
  selectedIds,
  onApply,
}: {
  pairs: [string, PairStats][]
  biomarkers: BiomarkerResult[]
  selectedIds: string[]
  onApply: (pairKey: string) => void
}) {
  const t = useTranslations('correlation')
  if (pairs.length === 0) return null
  const nameOf = (id: string) =>
    biomarkers.find((b) => b.id === id)?.definition.names.en ?? id
  const maxAbsR = Math.max(...pairs.map(([, s]) => Math.abs(s.r)))
  const selected = new Set(selectedIds)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex justify-end px-4 pt-2.5">
        <span className="text-[10px] text-muted-foreground/70">
          {t('topPairs.hint')}
        </span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1.5 [scrollbar-width:thin]">
        {pairs.map(([pairKey, s], i) => {
          const [a, b] = pairKey.split('|')
          const isSelected =
            selected.size === 2 && selected.has(a) && selected.has(b)
          return (
            <li key={pairKey}>
              <button
                type="button"
                onClick={() => onApply(pairKey)}
                title={t('topPairs.rowTitle', {
                  a: nameOf(a),
                  b: nameOf(b),
                  strength: strengthLabel(s.r, t),
                  readings: t('readingsCount', { count: s.n }),
                  confidence: confidenceLabel(s.n, s.p, t),
                })}
                className={cn(
                  'flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-muted/30',
                  isSelected && 'bg-primary/10 hover:bg-primary/10',
                )}
              >
                <span className="w-4 shrink-0 text-right text-[11px] font-semibold tabular-nums text-muted-foreground/70">
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-1 text-[11px] font-medium text-foreground">
                  <span className="min-w-0 truncate">{nameOf(a)}</span>
                  <span className="shrink-0 text-muted-foreground">×</span>
                  <span className="min-w-0 truncate">{nameOf(b)}</span>
                </span>
                <span
                  className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.round((Math.abs(s.r) / maxAbsR) * 100)}%`,
                      backgroundColor: rColor(s.r),
                    }}
                  />
                </span>
                <span
                  className="w-12 shrink-0 text-right text-[11px] font-semibold tabular-nums"
                  style={{ color: rColor(s.r) }}
                >
                  {s.r.toFixed(2)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CorrelationLegend() {
  const t = useTranslations('correlation')
  return (
    <div className="border-t border-border bg-muted/10 px-4 py-2">
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {t('legend.intro')}{' '}
        <span className="font-medium">{t('legend.rPlusOne')}</span>
        {t('legend.afterPlusOne')}{' '}
        <span className="font-medium">{t('legend.rMinusOne')}</span>
        {t('legend.afterMinusOne')}{' '}
        {t('legend.confidence', { phrase: t('confidence.real') })}
      </p>
    </div>
  )
}

export function CorrelationChart({ biomarkers: allBiomarkers }: { biomarkers: BiomarkerResult[] }) {
  const t = useTranslations('correlation')
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [leftTab, setLeftTab] = useState<'pairs' | 'select'>('pairs')
  const userInteracted = useRef(false)

  const allChartable = useMemo(
    () => allBiomarkers.filter(hasReadings),
    [allBiomarkers],
  )

  // Correlations across ALL chartable biomarkers (not just the selected
  // ones), so high-correlation pairs can be surfaced automatically.
  const allPairStats = useMemo(() => {
    if (allChartable.length < 2) return {}
    const { series } = buildAlignedSeries(allChartable)
    return pairwiseCorrelations(series)
  }, [allChartable])

  // Pairs with enough shared readings to be meaningful. |r| >= 0.5 avoids
  // surfacing noise; n >= 4 keeps tiny samples (where a perfect fit is
  // trivial) from dominating the list with spurious r = ±1.
  const suggestedPairs = useMemo(
    () =>
      Object.entries(allPairStats)
        .filter(([, s]) => s.n >= 4 && Math.abs(s.r) >= 0.5)
        .sort(
          (a, b) =>
            Math.abs(b[1].r) - Math.abs(a[1].r) || b[1].n - a[1].n,
        ),
    [allPairStats],
  )

  useEffect(() => {
    if (userInteracted.current || allBiomarkers.length === 0) return
    let next = allChartable.slice(0, 2).map((b) => b.id)
    if (suggestedPairs.length > 0) {
      next = suggestedPairs[0][0].split('|')
    }
    setSelectedIds(next)
  }, [allBiomarkers, allChartable, suggestedPairs])

  // Prune selections that no longer exist after a refetch (ISSUES.md #75):
  // a removed/changed definition id in selectedIds would render a legend
  // entry and color mapping for a series that can no longer appear.
  // Adjusted during render (React 19 pattern) to avoid setState-in-effect.
  const [prevChartable, setPrevChartable] = useState(allChartable)
  if (prevChartable !== allChartable) {
    setPrevChartable(allChartable)
    const valid = selectedIds.filter((id) => allChartable.some((b) => b.id === id))
    if (valid.length !== selectedIds.length) {
      setSelectedIds(valid)
    }
  }

  const colorMap = useMemo(() => {
    const map: Record<string, string> = {}
    selectedIds.forEach((id, i) => {
      map[id] = CLINICAL_PALETTE[i % CLINICAL_PALETTE.length]
    })
    return map
  }, [selectedIds])

  const filteredBiomarkers = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allChartable
    return allChartable.filter((b) => {
      const names = b.definition.names
      return Object.keys(names).some((key) =>
        names[key].toLowerCase().includes(q),
      )
    })
  }, [query, allChartable])

  const toggleBiomarker = (id: string) => {
    userInteracted.current = true
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const applyPair = (pairKey: string) => {
    userInteracted.current = true
    const [a, b] = pairKey.split('|')
    setSelectedIds([a, b])
  }

  const selectedBiomarkers = useMemo(
    () => allBiomarkers.filter((b) => selectedIds.includes(b.id) && hasReadings(b)),
    [selectedIds, allBiomarkers],
  )

  const chartData = useMemo(() => {
    const selected = selectedBiomarkers
    if (selected.length === 0) return []
    const { dates, byId } = buildAlignedSeries(selected)
    return dates.map((date) => {
      const entry: Record<string, number | string | null> = { date }
      selected.forEach((b) => {
        const point = byId[b.id].get(date)
        if (point != null) {
          const numericVal =
            typeof point === 'number' && Number.isFinite(point)
              ? point
              : qualitativeToNumber(point)
          const ref = b.reference ?? b.definition.reference
          entry[`norm_${b.id}`] =
            numericVal != null ? normalizedValue(numericVal, ref) : null
          entry[`raw_${b.id}`] = point ?? null
        } else {
          entry[`norm_${b.id}`] = null
          entry[`raw_${b.id}`] = null
        }
      })
      return entry
    })
  }, [selectedBiomarkers])

  const pairStats = useMemo(() => {
    const series: Record<string, Array<number | null>> = {}
    chartData.forEach((row) => {
      selectedBiomarkers.forEach((b) => {
        const v = row[`norm_${b.id}`]
        ;(series[b.id] ??= []).push(typeof v === 'number' ? v : null)
      })
    })
    return pairwiseCorrelations(series)
  }, [chartData, selectedBiomarkers])

  const yDomain = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    chartData.forEach((row) => {
      selectedBiomarkers.forEach((b) => {
        const v = row[`norm_${b.id}`]
        if (typeof v === 'number') {
          min = Math.min(min, v)
          max = Math.max(max, v)
        }
      })
    })
    if (!Number.isFinite(min)) return [0, 100] as [number, number]
    const pad = Math.max((max - min) * 0.1, 5)
    return [Math.min(0, min - pad), Math.max(100, max + pad)] as [number, number]
  }, [chartData, selectedBiomarkers])

  const pointCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    selectedBiomarkers.forEach((b) => {
      counts[b.id] = chartData.filter((row) => row[`norm_${b.id}`] != null).length
    })
    return counts
  }, [chartData, selectedBiomarkers])

  return (
    <div className="grid h-[calc(100vh-220px)] w-full grid-cols-[380px_1fr] gap-5">
      <Card className="flex h-full min-h-0 flex-col border-border">
        <div className="flex items-center gap-x-2 border-b border-border px-3 py-2.5">
          <button
            type="button"
            onClick={() => setLeftTab('pairs')}
            className={cn(
              'whitespace-nowrap text-sm transition-colors',
              leftTab === 'pairs'
                ? 'font-semibold text-foreground'
                : 'font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            {t('tabs.topPairs')}
          </button>
          <span className="text-sm text-muted-foreground/20">|</span>
          <button
            type="button"
            onClick={() => setLeftTab('select')}
            className={cn(
              'whitespace-nowrap text-sm transition-colors',
              leftTab === 'select'
                ? 'font-semibold text-foreground'
                : 'font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            {t('tabs.select')}
          </button>
        </div>
        {leftTab === 'pairs' ? (
          suggestedPairs.length > 0 ? (
            <TopCorrelatedPairs
              pairs={suggestedPairs}
              biomarkers={allBiomarkers}
              selectedIds={selectedIds}
              onApply={applyPair}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-6">
              <p className="text-center text-xs leading-relaxed text-muted-foreground">
                {allBiomarkers.length === 0
                  ? t('empty.noData')
                  : t('empty.noPairs', { tab: t('tabs.select') })}
              </p>
            </div>
          )
        ) : (
          <>
            <div className="border-b border-border p-4">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('searchPlaceholder')}
                  className="pl-8"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
              {filteredBiomarkers.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {allBiomarkers.length === 0
                    ? t('empty.noData')
                    : t('empty.noMatching')}
                </p>
              )}
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
                      {b.definition.names.en}
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
          </>
        )}
      </Card>

      <Card className="flex h-full min-h-0 flex-col border-border">
        <div className="border-b border-border p-4">
          <h2 className="text-base font-semibold text-foreground">
            {t('heading')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <CorrelationStats
          pairStats={pairStats}
          selectedIds={selectedIds}
          biomarkers={allBiomarkers}
        />
        <div className="min-h-0 flex-1 p-4">
          {selectedIds.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('empty.selectAtLeastOne')}
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('empty.noNumeric')}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
              >
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={{ stroke: '#d4d4d8' }}
                  padding={{ left: 20, right: 20 }}
                  tick={dateTickRenderer(locale)}
                />
                <YAxis hide domain={yDomain} />
                <ReferenceArea
                  y1={0}
                  y2={100}
                  fill="#22c55e"
                  fillOpacity={0.05}
                />
                <Tooltip content={<CustomTooltip biomarkers={allBiomarkers} />} />
                {selectedBiomarkers.map((b) => (
                  <Line
                    key={b.id}
                    type="monotone"
                    dataKey={`norm_${b.id}`}
                    stroke={colorMap[b.id]}
                    strokeWidth={2}
                    dot={
                      (pointCounts[b.id] ?? 0) <= 1
                        ? { r: 4, strokeWidth: 2, fill: '#fff', stroke: colorMap[b.id] }
                        : false
                    }
                    activeDot={{ r: 5, fill: colorMap[b.id] }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        {allChartable.length > 1 && <CorrelationLegend />}
      </Card>
    </div>
  )
}
