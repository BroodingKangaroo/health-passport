import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function splitDateLabel(dateStr: string): { label: string; sub?: string } {
  const idx = dateStr.indexOf(" at ")
  if (idx === -1) return { label: dateStr }
  return { label: dateStr.slice(0, idx), sub: dateStr.slice(idx + 4) }
}
