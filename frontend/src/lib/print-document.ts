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

/**
 * An ISO-8601 instant (a link's expiry) as the document's own date format.
 *
 * Only the calendar date is read: an expiry is a day, and rendering it in the
 * reader's timezone would move it. Anything unparseable is returned as it
 * arrived rather than swallowed, so a bad value is visible instead of blank.
 */
export function formatIsoDate(value: string, lang: PrintLang): string {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return value
  return formatDob(`${m[1]}-${m[2]}-${m[3]}`, lang)
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

/**
 * Provenance for a document printed from a SHARED record (ST4, plan §4).
 *
 * A printed sheet is the one output that escapes revocation: the sender can
 * close a link, but not recall paper. So a shared document says where it came
 * from, when the link stops working, and that it is not a diagnosis — the
 * things a colleague handed a photocopy needs in order to judge it and to
 * find its source.
 *
 * `{date}` is substituted with the link's expiry in this document's own date
 * format. These are DOCUMENT-language strings, like `TABLE_HEADINGS` above —
 * deliberately NOT entries in the UI catalogs.
 */
export const DOCUMENT_PROVENANCE: Record<
  PrintLang,
  { sharedVia: string; accessUntil: string; notDiagnosis: string }
> = {
  en: {
    sharedVia: 'Shared via HealthPassport',
    accessUntil: 'Link access until {date}',
    notDiagnosis:
      'This document was generated from a record shared by its owner. It is not a medical diagnosis.',
  },
  ru: {
    sharedVia: '\u041F\u0435\u0440\u0435\u0434\u0430\u043D\u043E \u0447\u0435\u0440\u0435\u0437 HealthPassport',
    accessUntil: '\u0414\u043E\u0441\u0442\u0443\u043F \u043F\u043E \u0441\u0441\u044B\u043B\u043A\u0435 \u0434\u043E {date}',
    notDiagnosis:
      '\u042D\u0442\u043E\u0442 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u0441\u0444\u043E\u0440\u043C\u0438\u0440\u043E\u0432\u0430\u043D \u0438\u0437 \u0437\u0430\u043F\u0438\u0441\u0438, \u043A\u043E\u0442\u043E\u0440\u043E\u0439 \u043F\u043E\u0434\u0435\u043B\u0438\u043B\u0441\u044F \u0435\u0451 \u0432\u043B\u0430\u0434\u0435\u043B\u0435\u0446. \u042D\u0442\u043E \u043D\u0435 \u043C\u0435\u0434\u0438\u0446\u0438\u043D\u0441\u043A\u0438\u0439 \u0434\u0438\u0430\u0433\u043D\u043E\u0437.',
  },
  de: {
    sharedVia: 'Geteilt \u00FCber HealthPassport',
    accessUntil: 'Linkzugriff bis {date}',
    notDiagnosis:
      'Dieses Dokument wurde aus einer vom Eigent\u00FCmer geteilten Akte erstellt. Es ist keine medizinische Diagnose.',
  },
  fr: {
    sharedVia: 'Partag\u00E9 via HealthPassport',
    accessUntil: 'Acc\u00E8s au lien jusqu\u2019au {date}',
    notDiagnosis:
      'Ce document a \u00E9t\u00E9 g\u00E9n\u00E9r\u00E9 \u00E0 partir d\u2019un dossier partag\u00E9 par son titulaire. Il ne constitue pas un diagnostic m\u00E9dical.',
  },
  es: {
    sharedVia: 'Compartido v\u00EDa HealthPassport',
    accessUntil: 'Acceso al enlace hasta {date}',
    notDiagnosis:
      'Este documento se gener\u00F3 a partir de un historial compartido por su titular. No es un diagn\u00F3stico m\u00E9dico.',
  },
  he: {
    sharedVia: '\u05E9\u05D5\u05EA\u05E3 \u05D3\u05E8\u05DA HealthPassport',
    accessUntil: '\u05D2\u05D9\u05E9\u05D4 \u05DC\u05E7\u05D9\u05E9\u05D5\u05E8 \u05E2\u05D3 {date}',
    notDiagnosis:
      '\u05DE\u05E1\u05DE\u05DA \u05D6\u05D4 \u05D4\u05D5\u05E4\u05E7 \u05DE\u05E8\u05E9\u05D5\u05DE\u05D4 \u05E9\u05E9\u05D5\u05EA\u05E4\u05D4 \u05E2\u05DC \u05D9\u05D3\u05D9 \u05D1\u05E2\u05DC\u05D9\u05D4. \u05D0\u05D9\u05E0\u05D5 \u05D0\u05D1\u05D7\u05D5\u05DF \u05E8\u05E4\u05D5\u05D0\u05D9.',
  },
  pl: {
    sharedVia: 'Udost\u0119pnione przez HealthPassport',
    accessUntil: 'Dost\u0119p do linku do {date}',
    notDiagnosis:
      'Ten dokument powsta\u0142 na podstawie dokumentacji udost\u0119pnionej przez jej w\u0142a\u015Bciciela. Nie jest diagnoz\u0105 medyczn\u0105.',
  },
}
