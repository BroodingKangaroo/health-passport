/**
 * Display-time translations for the canonical qualitative enum and the
 * "Qualitative" unit-column label.
 *
 * The backend normalizes every qualitative result / reference expected text
 * into a closed enum of canonical English values (see
 * backend/app/services/reference.py `normalize_qual`); unknown text passes
 * through verbatim. Stored data ALWAYS stays canonical English — status
 * computation, `isOutsideReference`, and `qualitativeToNumber` compare the
 * stored strings — so this map is applied only at render time.
 *
 * Keys must match the backend enum exactly (case-sensitive). Values that are
 * not canonical (raw document text, already-Russian strings, formatted
 * numbers) pass through unchanged.
 *
 * These are domain/document terms, deliberately NOT in the next-intl
 * catalogs: the print editor consumes them with the DOCUMENT language
 * (`lang` prop), independent of the UI locale — same policy as the other
 * per-language maps in `print-editor.tsx`.
 */

export const QUALITATIVE_LABELS: Record<string, Record<string, string>> = {
  en: {},
  ru: {
    Negative: 'Отрицательно',
    Positive: 'Положительно',
    Detected: 'Обнаружено',
    'Not detected': 'Не обнаружено',
    Absent: 'Отсутствует',
    Present: 'Присутствует',
    Normal: 'Норма',
    Abnormal: 'Отклонение',
  },
}

/** The word "Qualitative" as shown in unit columns / unit pickers. */
const QUALITATIVE_UNIT_LABELS: Record<string, string> = {
  en: 'Qualitative',
  ru: 'Качественный',
}

/**
 * Translate a canonical qualitative value for display. Exact (case-sensitive)
 * canonical matches map to the target language; everything else — raw
 * document text, unknown strings, numbers — is returned unchanged.
 */
export function qualitativeLabel(
  value: string | number | null | undefined,
  lang: string = 'en',
): string {
  if (value == null) return ''
  const v = typeof value === 'string' ? value : String(value)
  return QUALITATIVE_LABELS[lang]?.[v] ?? v
}

/** Localized label for the qualitative unit-column sentinel. */
export function qualitativeUnitLabel(lang: string = 'en'): string {
  return QUALITATIVE_UNIT_LABELS[lang] ?? 'Qualitative'
}
