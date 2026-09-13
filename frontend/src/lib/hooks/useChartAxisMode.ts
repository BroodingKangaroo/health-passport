'use client'

import { useCallback, useSyncExternalStore } from 'react'

import type { AxisMode } from '@/lib/chart-series'

const STORAGE_KEY = 'hp.chartAxisMode'
const DEFAULT_MODE: AxisMode = 'time'
const listeners = new Set<() => void>()
// In-memory fallback when localStorage is unavailable or unwritable.
let memoryMode: AxisMode | null = null

function isAxisMode(value: string | null): value is AxisMode {
  return value === 'even' || value === 'time'
}

function readStored(): AxisMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (isAxisMode(stored)) return stored
  } catch {
    // Private mode / storage disabled — fall back to the in-memory choice.
  }
  return memoryMode ?? DEFAULT_MODE
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  window.addEventListener('storage', callback)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('storage', callback)
  }
}

function notify() {
  listeners.forEach((listener) => listener())
}

/**
 * Global chart-axis preference: warped time scale (`time`, default) or
 * equidistant slots (`even`). Backed by localStorage as an external store
 * (`useSyncExternalStore`): the server snapshot is always the default, so
 * hydration is stable, and same-tab updates fan out to every mounted chart
 * through a module-level listener set (`storage` events cover other tabs).
 */
export function useChartAxisMode(): [AxisMode, (mode: AxisMode) => void] {
  const mode = useSyncExternalStore(subscribe, readStored, () => DEFAULT_MODE)
  const update = useCallback((next: AxisMode) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
      memoryMode = null
    } catch {
      // Private mode / storage disabled — in-memory listeners still apply.
      memoryMode = next
    }
    notify()
  }, [])
  return [mode, update]
}
