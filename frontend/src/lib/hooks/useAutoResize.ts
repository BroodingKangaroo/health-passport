'use client'

import { useCallback, type RefObject } from 'react'

export function useAutoResize(ref: RefObject<HTMLTextAreaElement | null>) {
  return useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [ref])
}
