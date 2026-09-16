import { describe, expect, it } from 'vitest'

import { resolveSharedLocale } from '@/i18n/shared-locale'

/**
 * The recipient's language is the recipient's business: a share link must
 * never render in the sender's language, and opening one must not write the
 * `NEXT_LOCALE` cookie the authed app reads.
 */
describe('resolveSharedLocale', () => {
  it('prefers an explicit ?lang= over everything else', () => {
    expect(
      resolveSharedLocale({ lang: 'ru', acceptLanguage: 'en-US', cookieLocale: 'en' }),
    ).toBe('ru')
    // An unsupported ?lang= is ignored rather than trusted.
    expect(resolveSharedLocale({ lang: 'de', acceptLanguage: 'ru' })).toBe('ru')
  })

  it('falls back to the recipient browser language', () => {
    expect(resolveSharedLocale({ acceptLanguage: 'ru-RU,ru;q=0.9,en;q=0.8' })).toBe('ru')
    expect(resolveSharedLocale({ acceptLanguage: 'en-GB,en;q=0.9' })).toBe('en')
  })

  it('honours q-values and skips unacceptable or unsupported entries', () => {
    expect(resolveSharedLocale({ acceptLanguage: 'en;q=0.5, ru;q=0.9' })).toBe('ru')
    expect(resolveSharedLocale({ acceptLanguage: 'ru;q=0' })).toBe('en')
    expect(resolveSharedLocale({ acceptLanguage: 'fr-FR,fr;q=0.9' })).toBe('en')
  })

  it('uses NEXT_LOCALE only when the browser asks for nothing we support', () => {
    expect(resolveSharedLocale({ acceptLanguage: 'de-DE', cookieLocale: 'ru' })).toBe('ru')
    expect(resolveSharedLocale({ cookieLocale: 'ru' })).toBe('ru')
  })

  it('defaults to English', () => {
    expect(resolveSharedLocale({})).toBe('en')
    expect(
      resolveSharedLocale({ acceptLanguage: '*;q=1.0', cookieLocale: 'fr' }),
    ).toBe('en')
  })
})
