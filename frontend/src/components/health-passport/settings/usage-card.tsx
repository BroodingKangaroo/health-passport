'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Gauge } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { formatBytes } from '@/components/health-passport/entry-settings'
import { fetchUsageLimits } from '@/services/api'
import type { UsageLimits } from '@/lib/types'

function UsageBar({
  label,
  used,
  total,
  usedOfText,
  limitReachedText,
}: {
  label: string
  used: number
  total: number
  usedOfText: string
  limitReachedText: string
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  const atLimit = total > 0 && used >= total
  return (
    <div className="space-y-1.5" data-testid="usage-bar">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-xs font-medium text-foreground">
          {atLimit ? limitReachedText : usedOfText}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
          data-testid="usage-bar-fill"
        />
      </div>
    </div>
  )
}

export function UsageCard() {
  const t = useTranslations('settings.usage')
  const locale = useLocale()
  const [limits, setLimits] = useState<UsageLimits | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchUsageLimits()
      .then((l) => {
        if (!cancelled) setLimits(l)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Card className="p-6" data-testid="usage-card">
      <div className="mb-4 flex items-center gap-2">
        <Gauge className="size-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {t('title')}
        </h3>
      </div>

      {failed ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : !limits ? (
        <div className="space-y-3" data-testid="usage-loading">
          <div className="h-5 w-full animate-pulse rounded bg-muted" />
          <div className="h-5 w-full animate-pulse rounded bg-muted" />
        </div>
      ) : (
        <div className="space-y-4">
          <UsageBar
            label={t('extractions')}
            used={limits.ai_extraction_count}
            total={limits.ai_extraction_limit}
            usedOfText={t('usedOf', {
              used: limits.ai_extraction_count,
              total: limits.ai_extraction_limit,
            })}
            limitReachedText={t('limitReached')}
          />
          <UsageBar
            label={t('storage')}
            used={limits.total_upload_size_bytes}
            total={limits.total_upload_limit_bytes}
            usedOfText={t('usedOf', {
              used: formatBytes(limits.total_upload_size_bytes, locale),
              total: formatBytes(limits.total_upload_limit_bytes, locale),
            })}
            limitReachedText={t('limitReached')}
          />
        </div>
      )}
    </Card>
  )
}
