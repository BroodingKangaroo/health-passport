import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale } from 'next-intl/server'
import { ThemeProvider } from '@/providers/theme-provider'
import { QueryProvider } from '@/providers/query-provider'
import { PrintConfigProvider } from '@/providers/print-config-provider'
import { LeaveGuardProvider } from '@/providers/leave-guard-provider'
import { AuthProvider } from '@/components/providers/AuthProvider'
import { Toaster } from 'sonner'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin', 'cyrillic'] })
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin', 'cyrillic'],
})

export const metadata: Metadata = {
  title: 'HealthPassport — Medical Flowsheet',
  description:
    'Clinical-grade medical flowsheet and history dashboard for lab results, visits, and instrumental tests.',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const locale = await getLocale()
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} bg-background`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('theme-preference');
                  if (theme === 'dark') {
                    document.documentElement.classList.add('dark');
                  } else if (theme === 'light') {
                    document.documentElement.classList.add('light');
                  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                    document.documentElement.classList.add('dark');
                  }
                } catch(e) {}
              })();
            `,
          }}
        />
        {/* First-visit locale detection: persist the browser language in the
            NEXT_LOCALE cookie (the single source of truth for the UI locale).
            If a Russian browser lands on an English-rendered page, reload once
            so the server re-renders with the cookie set. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var m = document.cookie.match(/(?:^|; )NEXT_LOCALE=(en|ru)(?:;|$)/);
                  if (!m) {
                    var lang = (navigator.language || 'en').toLowerCase();
                    var loc = lang.indexOf('ru') === 0 ? 'ru' : 'en';
                    document.cookie = 'NEXT_LOCALE=' + loc + '; path=/; max-age=31536000; samesite=lax';
                    if (loc === 'ru') location.reload();
                  }
                } catch(e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <AuthProvider>
          <ThemeProvider>
            <QueryProvider>
              <NextIntlClientProvider>
                <LeaveGuardProvider>
                  <PrintConfigProvider>{children}</PrintConfigProvider>
                </LeaveGuardProvider>
              </NextIntlClientProvider>
            </QueryProvider>
          </ThemeProvider>
        </AuthProvider>
        <Toaster position="bottom-right" richColors />
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
