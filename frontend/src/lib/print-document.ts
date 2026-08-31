import type { DateHeader } from './types'

/**
 * Shared print-document helpers (ISSUES.md #73 / #74). `dateId` is THE
 * identifier for a date column: `usePrintConfig.selectedDates`,
 * `print-editor.tsx`, and `PrintEditorView.tsx` all live in the same id
 * space and must never drift.
 */
export function dateId(d: DateHeader): string {
  return d.label + (d.sub ? '--' + d.sub : '')
}
