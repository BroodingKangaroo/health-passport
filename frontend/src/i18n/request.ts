import { getRequestConfig } from 'next-intl/server'
import { cookies } from 'next/headers'
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, messages, type AppLocale } from './messages'

/**
 * Server-side locale resolution. The locale lives ONLY in the `NEXT_LOCALE`
 * cookie — there is no URL-based locale routing, so the route structure, the
 * `/api` proxy rewrites and the print flow are untouched. The LanguageSwitch
 * sets the cookie and calls `router.refresh()`, which re-renders the server
 * tree (including `<html lang>` and the message set below).
 */
export default getRequestConfig(async () => {
  const store = await cookies()
  const raw = store.get('NEXT_LOCALE')?.value
  const locale: AppLocale = (SUPPORTED_LOCALES as readonly string[]).includes(raw ?? '')
    ? (raw as AppLocale)
    : DEFAULT_LOCALE

  return {
    locale,
    messages: messages[locale],
  }
})
