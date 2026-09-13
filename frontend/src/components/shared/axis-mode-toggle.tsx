'use client'

import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'
import type { AxisMode } from '@/lib/chart-series'

const MODES: AxisMode[] = ['time', 'even']

/**
 * Two-state segmented control for a chart's x-axis: warped time scale
 * (`time`) or equidistant slots (`even`). Mutually exclusive view options are
 * exposed as `aria-pressed` buttons (the LanguageSwitch pattern); `label`
 * names the chart for assistive tech.
 */
export function AxisModeToggle({
  mode,
  onChange,
  label,
  className,
}: {
  mode: AxisMode
  onChange: (mode: AxisMode) => void
  label: string
  className?: string
}) {
  const t = useTranslations('charts.axisMode')
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-background p-0.5',
        className,
      )}
    >
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={cn(
            'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
            mode === m
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t(m)}
        </button>
      ))}
    </div>
  )
}
