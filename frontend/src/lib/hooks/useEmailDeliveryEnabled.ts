'use client'

import { useEffect, useState } from 'react'

import { fetchEmailDeliveryEnabled } from '@/services/api'

/**
 * Instance capability flag for the two "we emailed you" flows (password reset,
 * email change): `false` means this deployment has no SMTP transport, so no
 * message will arrive. `null` = unknown (still probing, or the probe failed),
 * and callers must stay silent rather than warn on a guess.
 *
 * This exists because the backend cannot report per-address delivery failures
 * without enabling user enumeration; SMTP-off is the one delivery failure that
 * is account-independent and therefore safe to show.
 */
export function useEmailDeliveryEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchEmailDeliveryEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value)
      })
      .catch(() => {
        if (!cancelled) setEnabled(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return enabled
}
