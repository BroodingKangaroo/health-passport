import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type AppLocale } from './messages'

/**
 * Locale resolution for the PUBLIC share surface.
 *
 * The authed app resolves its locale from the `NEXT_LOCALE` cookie alone
 * (`request.ts`). A recipient has no cookie and must not get one written, so
 * the shared route resolves its own locale, in this order:
 *
 *   1. `?lang=` on the URL (when supported)
 *   2. the request's `Accept-Language` — the recipient's browser
 *   3. `NEXT_LOCALE`, if the visitor happens to have one
 *   4. `en`
 *
 * The sender's own language never decides what the recipient reads.
 */

export function isSupportedLocale(value: string | null | undefined): value is AppLocale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export function resolveSharedLocale(opts: {
  lang?: string | null
  acceptLanguage?: string | null
  cookieLocale?: string | null
}): AppLocale {
  if (isSupportedLocale(opts.lang)) return opts.lang
  const fromHeader = pickFromAcceptLanguage(opts.acceptLanguage)
  if (fromHeader) return fromHeader
  if (isSupportedLocale(opts.cookieLocale)) return opts.cookieLocale
  return DEFAULT_LOCALE
}

/** Same q-value rules as the backend's `resolve_locale`: highest q wins,
 *  ties go to the earlier entry, `q=0` and `*` are skipped. */
function pickFromAcceptLanguage(header?: string | null): AppLocale | null {
  if (!header) return null
  let bestLocale: AppLocale | null = null
  let bestQ = -1
  header.split(',').forEach((part) => {
    const [tagPart, ...params] = part.split(';')
    const tag = tagPart.trim().toLowerCase()
    if (!tag || tag === '*') return
    let q = 1
    for (const param of params) {
      const [rawKey, rawValue] = param.split('=')
      if (rawKey?.trim() === 'q') {
        const parsed = Number.parseFloat(rawValue ?? '')
        q = Number.isFinite(parsed) ? parsed : 0
      }
    }
    if (q <= 0) return
    const base = tag.split('-')[0]
    if (!isSupportedLocale(base)) return
    if (q > bestQ) {
      bestQ = q
      bestLocale = base
    }
  })
  return bestLocale
}
