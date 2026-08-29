/**
 * Localized labels for the backend's persisted status enum
 * (`normal | low | high | abnormal`), which some components render raw.
 * Unknown statuses fall back to the raw value.
 */
export type StatusTranslator = (key: string) => string

export function localizedStatus(status: string | null | undefined, t: StatusTranslator): string {
  if (!status) return ''
  const key = status.toLowerCase()
  if (key === 'normal' || key === 'low' || key === 'high' || key === 'abnormal') {
    return t(`statuses.${key}`)
  }
  return status
}
