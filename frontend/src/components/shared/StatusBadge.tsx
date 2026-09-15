'use client'

import { Check, ArrowDown, ArrowUp, AlertTriangle, HelpCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import type { Status } from '@/lib/types'

export function StatusBadge({ status }: { status: Status }) {
  const t = useTranslations('statuses')
  if (status === 'normal') {
    return (
      <Badge variant="normal">
        <Check className="size-3" />
        {t('normal')}
      </Badge>
    )
  }
  if (status === 'low') {
    return (
      <Badge variant="low">
        <ArrowDown className="size-3" />
        {t('low')}
      </Badge>
    )
  }
  if (status === 'high') {
    return (
      <Badge variant="high">
        <ArrowUp className="size-3" />
        {t('high')}
      </Badge>
    )
  }
  if (status === 'abnormal') {
    return (
      <Badge variant="abnormal">
        <AlertTriangle className="size-3" />
        {t('abnormal')}
      </Badge>
    )
  }
  // Unknown (`''`) — a numeric result against an unrecognized qualitative
  // expected value. Neutral chip: it is NOT a health warning.
  return (
    <Badge variant="chip">
      <HelpCircle className="size-3" />
      {t('unknown')}
    </Badge>
  )
}
