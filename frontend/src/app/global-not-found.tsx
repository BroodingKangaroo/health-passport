import type { Viewport } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { Geist, Geist_Mono } from 'next/font/google'
import { resolveSharedLocale } from '@/i18n/shared-locale'
// Same stylesheet as both root layouts; it stays at the app root for exactly
// this reason.
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
 * The document for an unmatched URL.
 *
 * The app has two ROOT layouts (the `(app)` and `(public)` route groups) and no
 * `app/layout.tsx`, so Next cannot pick one for a URL that matches no route and
 * would otherwise serve its bare built-in document — no `lang`, no stylesheet,
 * no fonts. This file supplies the shell, exactly as `app/layout.tsx` did for
 * every route before the split.
 *
 * It is deliberately NOT inside the `(public)` tree: a 404 is not part of the
 * shared surface, renders no recipient chrome, and pulls a single link back to
 * the app root.
 */
export default async function GlobalNotFound() {
  const locale = resolveSharedLocale({
    acceptLanguage: (await headers()).get('accept-language'),
  })
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} bg-background`}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased">
        <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-5 text-center">
          <p className="text-2xl font-bold text-foreground">404</p>
          <p className="text-sm text-muted-foreground">This page could not be found.</p>
          <Link
            href="/"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            HealthPassport
          </Link>
        </main>
      </body>
    </html>
  )
}
