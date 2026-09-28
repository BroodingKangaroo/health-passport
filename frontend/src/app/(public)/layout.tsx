import type { Viewport } from 'next'
import { cookies, headers } from 'next/headers'
import { Geist, Geist_Mono } from 'next/font/google'
import { resolveSharedLocale, SHARE_LANG_HEADER } from '@/i18n/shared-locale'
// globals.css lives at the app root so both root layouts import the same
// stylesheet.
import '@/app/globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin', 'cyrillic'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin', 'cyrillic'] })

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

/**
 * Root layout for the public share surface.
 *
 * This exists as a SECOND root layout (route group `(public)`, no
 * `app/layout.tsx` above it) specifically so a recipient never mounts the
 * authed tree: `AuthProvider` would fetch `/api/auth/session` and could mint
 * a session cookie for someone who is only opening a link. A share link has to
 * be readable by a stranger without creating anything about them.
 *
 * `<html lang>` is resolved HERE, on the server, in the same order the page
 * uses: `?lang=` (carried in by the share middleware, because a layout cannot
 * read `searchParams`) → `Accept-Language` → `NEXT_LOCALE`. Only the link's
 * own `default_locale` is missing — that lives inside the record, so the
 * page's `DocumentLang` helper applies it after hydration. Theming follows
 * the system preference through the `prefers-color-scheme` block in
 * globals.css — no localStorage read, so a recipient does not inherit the
 * sender's theme.
 */
export default async function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const [requestHeaders, cookieStore] = await Promise.all([headers(), cookies()])
  const locale = resolveSharedLocale({
    lang: requestHeaders.get(SHARE_LANG_HEADER),
    acceptLanguage: requestHeaders.get('accept-language'),
    cookieLocale: cookieStore.get('NEXT_LOCALE')?.value,
  })
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} bg-background`}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
