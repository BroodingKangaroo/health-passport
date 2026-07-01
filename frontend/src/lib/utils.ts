import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const base = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (d.getHours() !== 0 || d.getMinutes() !== 0) {
    return `${base} at ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }
  return base
}

export function splitDateLabel(dateStr: string): { label: string; sub?: string } {
  const d = new Date(dateStr)
  if (!isNaN(d.getTime())) {
    const base = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    if (d.getHours() !== 0 || d.getMinutes() !== 0) {
      return {
        label: base,
        sub: `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
      }
    }
    return { label: base }
  }
  const idx = dateStr.indexOf(' at ')
  if (idx === -1) return { label: dateStr }
  return { label: dateStr.slice(0, idx), sub: dateStr.slice(idx + 4) }
}
