'use client'

import { Check, ArrowDown, ArrowUp, AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { Status } from '@/lib/types'

export function StatusBadge({ status }: { status: Status }) {
  if (status === 'normal') {
    return (
      <Badge variant="normal">
        <Check className="size-3" />
        Normal
      </Badge>
    )
  }
  if (status === 'low') {
    return (
      <Badge variant="low">
        <ArrowDown className="size-3" />
        Low
      </Badge>
    )
  }
  if (status === 'high') {
    return (
      <Badge variant="high">
        <ArrowUp className="size-3" />
        High
      </Badge>
    )
  }
  return (
    <Badge variant="abnormal">
      <AlertTriangle className="size-3" />
      Abnormal
    </Badge>
  )
}
