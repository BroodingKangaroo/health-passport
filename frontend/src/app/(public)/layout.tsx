import type { Viewport } from 'next'
import { headers } from 'next/headers'
import { Geist, Geist_Mono } from 'next/font/google'
import { resolveSharedLocale } from '@/i18n/shared-locale'
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
 * `<html lang>` comes from the recipient's `Accept-Language`; the page's
 * `?lang=` override is applied by a small client helper, because layouts do
 * not receive `searchParams`. Theming follows the system preference through
 * the `prefers-color-scheme` block in globals.css — no localStorage read, so
 * a recipient does not inherit the sender's theme.
 */
export default async function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const locale = resolveSharedLocale({
    acceptLanguage: (await headers()).get('accept-language'),
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
