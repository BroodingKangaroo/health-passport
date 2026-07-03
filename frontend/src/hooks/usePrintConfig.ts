'use client'

import { useContext } from 'react'
import { PrintConfigContext } from '@/providers/print-config-provider'

export function usePrintConfig() {
  const ctx = useContext(PrintConfigContext)
  if (!ctx) {
    throw new Error('usePrintConfig must be used within a PrintConfigProvider')
  }
  return ctx
}
