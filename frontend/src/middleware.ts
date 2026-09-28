import { NextResponse, type NextRequest } from 'next/server'

import { SHARE_LANG_HEADER, shareLangHeaderValue } from '@/i18n/shared-locale'

/**
 * Carries the shared view's `?lang=` from the URL into the render.
 *
 * The public layout is what emits `<html lang>`, and an App Router layout
 * cannot read `searchParams` — so without this the server-rendered attribute
 * came from `Accept-Language` alone and an English browser opening
 * `?lang=ru` shipped `lang="en"` until a client helper corrected it after
 * hydration. A tag that is wrong for the first paint is the one screen
 * readers, `:lang()` rules and hyphenation all read from.
 *
 * A request header (not a response one) is the only channel that reaches the
 * server components. Matched to the share route only, so the authed app and
 * the API proxy are untouched, and any inbound copy of the header is dropped
 * before the URL is read — a recipient cannot forge a locale.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers)
  const lang = shareLangHeaderValue(request.nextUrl.searchParams.get('lang'))
  if (lang) headers.set(SHARE_LANG_HEADER, lang)
  else headers.delete(SHARE_LANG_HEADER)
  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: ['/s/:path*'],
}
