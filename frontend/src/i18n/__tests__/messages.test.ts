import { describe, expect, it } from 'vitest'
import { messages, SUPPORTED_LOCALES } from '@/i18n/messages'

function flatten(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix]
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  )
}

describe('i18n message catalogs', () => {
  it('every locale has an identical key set to English', () => {
    const enKeys = flatten(messages.en).sort()
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === 'en') continue
      const keys = flatten(messages[locale]).sort()
      const missing = enKeys.filter((k) => !keys.includes(k))
      const extra = keys.filter((k) => !enKeys.includes(k))
      expect(missing, `missing in ${locale}`).toEqual([])
      expect(extra, `extra in ${locale}`).toEqual([])
    }
  })

  it('no value is empty in any locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of flatten(messages[locale])) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
            messages[locale],
          )
        expect(typeof value === 'string' && value.length > 0, `${locale}:${key}`).toBe(true)
      }
    }
  })

  it('interpolation params match between locales (bare {param} tokens; ICU args excluded)', () => {
    const PARAM_RE = /\{(\w+)\}/g // matches bare params only — ICU args like {count, plural, ...} contain commas
    const enKeys = flatten(messages.en)
    for (const key of enKeys) {
      const en = key
        .split('.')
        .reduce<unknown>((acc, p) => (acc as Record<string, unknown>)?.[p], messages.en) as string
      const ru = key
        .split('.')
        .reduce<unknown>((acc, p) => (acc as Record<string, unknown>)?.[p], messages.ru) as string
      const enParams = [...en.matchAll(PARAM_RE)].map((m) => m[1]).sort()
      const ruParams = [...ru.matchAll(PARAM_RE)].map((m) => m[1]).sort()
      expect(ruParams, `param mismatch at ${key}`).toEqual(enParams)
    }
  })

  it('every ICU {plural, …} message carries an `other` clause in EVERY locale', () => {
    // ICU plural/select REQUIRE the `other` branch — next-intl throws
    // INVALID_MESSAGE: MISSING_OTHER_CLAUSE at render time otherwise (this
    // only surfaces in the locale that hits the message, so it must be
    // asserted statically here).
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of flatten(messages[locale])) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
            messages[locale],
          ) as string
        if (typeof value !== 'string' || !/\{\w+, plural,/.test(value)) continue
        expect(/\bother\s*\{/.test(value), `${locale}:${key} missing 'other' clause`).toBe(true)
      }
    }
  })
})
