import { describe, expect, it } from 'vitest'

import {
  resolveSharedLocale,
  shareLangHeaderValue,
} from '@/i18n/shared-locale'

/**
 * The recipient's language is the recipient's business: a share link must
 * never render in the sender's language, and opening one must not write the
 * `NEXT_LOCALE` cookie the authed app reads.
 */
describe('resolveSharedLocale', () => {
  it('prefers an explicit ?lang= over everything else', () => {
    expect(
      resolveSharedLocale({
        lang: 'ru',
        defaultLocale: 'en',
        acceptLanguage: 'en-US',
        cookieLocale: 'en',
      }),
    ).toBe('ru')
    // An unsupported ?lang= is ignored rather than trusted.
    expect(resolveSharedLocale({ lang: 'de', acceptLanguage: 'ru' })).toBe('ru')
  })

  it('lets the link preset outrank the recipient browser, but never ?lang=', () => {
    // S10: the sender's deliberate per-link choice beats Accept-Language...
    expect(
      resolveSharedLocale({ defaultLocale: 'ru', acceptLanguage: 'en-US' }),
    ).toBe('ru')
    // ...and the recipient can always override it.
    expect(
      resolveSharedLocale({ lang: 'en', defaultLocale: 'ru', acceptLanguage: 'ru-RU' }),
    ).toBe('en')
    // An unsupported preset is ignored, not trusted.
    expect(resolveSharedLocale({ defaultLocale: 'de', acceptLanguage: 'ru' })).toBe('ru')
    // No preset at all falls through to the browser exactly as before.
    expect(resolveSharedLocale({ defaultLocale: null, acceptLanguage: 'ru' })).toBe('ru')
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

/**
 * The share middleware carries `?lang=` to the server-rendered `<html lang>`
 * (review item 4). Only a value the site can actually render may travel —
 * everything else has to fall through to `Accept-Language`, including a
 * header a client tried to set on its own request.
 */
describe('shareLangHeaderValue', () => {
  it('passes through a supported locale from the URL', () => {
    expect(shareLangHeaderValue('en')).toBe('en')
    expect(shareLangHeaderValue('ru')).toBe('ru')
  })

  it('refuses anything the site cannot render', () => {
    expect(shareLangHeaderValue('de')).toBeNull()
    expect(shareLangHeaderValue('ru-RU')).toBeNull()
    expect(shareLangHeaderValue('')).toBeNull()
    expect(shareLangHeaderValue(null)).toBeNull()
    expect(shareLangHeaderValue(undefined)).toBeNull()
  })
})
