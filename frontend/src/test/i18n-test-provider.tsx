'use client'

import { NextIntlClientProvider } from 'next-intl'
import { messages, DEFAULT_LOCALE } from '@/i18n/messages'

/**
 * Wrap a component under test with the i18n context, defaulting to English so
 * existing English assertions keep passing. Use `locale="ru"` to test
 * Russian rendering.
 */
export function TestI18nProvider({
  children,
  locale = DEFAULT_LOCALE,
}: {
  children: React.ReactNode
  locale?: string
}) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale as keyof typeof messages]}>
      {children}
    </NextIntlClientProvider>
  )
}
