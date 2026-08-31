import type { PrintLang, DateHeader } from './types'

/**
 * Shared print-document helpers (ISSUES.md #73 / #74). `dateId` is THE
 * identifier for a date column: `usePrintConfig.selectedDates`,
 * `print-editor.tsx`, and `PrintEditorView.tsx` all live in the same id
 * space and must never drift.
 *
 * The 7-language maps below are DOCUMENT-language data (the printed
 * passport's own chrome) — deliberately NOT part of the UI locale
 * catalogs in src/i18n/messages.
 */
export function dateId(d: DateHeader): string {
  return d.label + (d.sub ? '--' + d.sub : '')
}

export const LANG_NAME: Record<PrintLang, string> = {
  ru: 'Russian',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  he: 'Hebrew',
  pl: 'Polish',
}

// Display names for a document's DETECTED source language (backend detector,
// surfaced on DateHeader.source_language / MatrixRow.original_lang). These
// are unrelated to the PrintLang 'ru' sentinel above, which selects
// "original" mode and is not the Russian language.
export const SOURCE_LANG_EN: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pl: 'Polish',
  ru: 'Russian',
  he: 'Hebrew',
}

// Original mode renders Russian chrome, so its label uses Russian names.
export const SOURCE_LANG_RU: Record<string, string> = {
  en: '\u0410\u043D\u0433\u043B\u0438\u0439\u0441\u043A\u0438\u0439',
  de: '\u041D\u0435\u043C\u0435\u0446\u043A\u0438\u0439',
  fr: '\u0424\u0440\u0430\u043D\u0446\u0443\u0437\u0441\u043A\u0438\u0439',
  es: '\u0418\u0441\u043F\u0430\u043D\u0441\u043A\u0438\u0439',
  pl: '\u041F\u043E\u043B\u044C\u0441\u043A\u0438\u0439',
  ru: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439',
  he: '\u0418\u0432\u0440\u0438\u0442',
}

const GENDER_RU: Record<string, string> = {
  Male: '\u041C\u0443\u0436\u0447\u0438\u043D\u0430',
  Female: '\u0416\u0435\u043D\u0449\u0438\u043D\u0430',
  Other: '\u0414\u0440\u0443\u0433\u043E\u0435',
}

export function formatDob(dob: string, lang: PrintLang): string {
  const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return dob
  const [, y, mo, d] = m
  return lang === 'ru' ? `${d}.${mo}.${y}` : `${mo}.${d}.${y}`
}

export function formatToday(lang: PrintLang): string {
  const now = new Date()
  const d = String(now.getDate()).padStart(2, '0')
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const y = now.getFullYear()
  return lang === 'ru' ? `${d}.${mo}.${y}` : `${mo}.${d}.${y}`
}

export function genderLabel(gender: string, lang: PrintLang): string {
  const cleaned = gender.trim()
  if (!cleaned) return ''
  if (lang === 'ru' && GENDER_RU[cleaned]) return GENDER_RU[cleaned]
  return cleaned
}

export const TABLE_HEADINGS: Record<PrintLang, { biomarker: string; title: string; note: string }> = {
  ru: {
    biomarker: '\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u044C',
    title: '\u0414\u0438\u043D\u0430\u043C\u0438\u043A\u0430 \u043F\u043E \u0438\u0441\u0441\u043B\u0435\u0434\u043E\u0432\u0430\u043D\u0438\u044E',
    note: '* \u0417\u043D\u0430\u0447\u0435\u043D\u0438\u044F \u0432\u043D\u0435 \u0440\u0435\u0444\u0435\u0440\u0435\u043D\u0441\u043D\u043E\u0433\u043E \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430',
  },
  en: {
    biomarker: 'Biomarker',
    title: 'Longitudinal Lab Results',
    note: '* Values outside reference range',
  },
  de: {
    biomarker: 'Biomarker',
    title: 'L\u00E4ngsschnitt der Laborwerte',
    note: '* Werte au\u00DFerhalb des Referenzbereichs',
  },
  fr: {
    biomarker: 'Biomarqueur',
    title: 'R\u00E9sultats de laboratoire longitudinaux',
    note: '* Valeurs hors plage de r\u00E9f\u00E9rence',
  },
  es: {
    biomarker: 'Biomarcador',
    title: 'Resultados de laboratorio longitudinales',
    note: '* Valores fuera del rango de referencia',
  },
  he: {
    biomarker: '\u05E1\u05DE\u05DF \u05D1\u05D9\u05D5\u05DC\u05D5\u05D2\u05D9',
    title: '\u05EA\u05D5\u05E6\u05D0\u05D5\u05EA \u05DE\u05E2\u05D1\u05D3\u05D4 \u05DC\u05D0\u05D5\u05E8\u05DA \u05D6\u05DE\u05DF',
    note: '* \u05E2\u05E8\u05DB\u05D9\u05DD \u05DE\u05D7\u05D5\u05E5 \u05DC\u05D8\u05D5\u05D5\u05D7 \u05D4\u05D9\u05D7\u05D9\u05E1',
  },
  pl: {
    biomarker: 'Biomarker',
    title: 'Wyniki bada\u0144 laboratoryjnych w czasie',
    note: '* Warto\u015Bci poza zakresem referencyjnym',
  },
}
