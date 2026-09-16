import type { Metadata } from 'next'
import { cookies, headers } from 'next/headers'
import { NextIntlClientProvider } from 'next-intl'

import { SharedRecordView } from '@/components/share/SharedRecordView'
import {
  DocumentLang,
  SharedLoadError,
  SharedUnavailable,
} from '@/components/share/SharedStates'
import { resolveSharedLocale } from '@/i18n/shared-locale'
import { sharedViewMessages } from '@/i18n/shared-messages'
import type { AppLocale } from '@/i18n/messages'
import { fetchSharedRecord, SharedLinkUnavailableError } from '@/services/share'
import type { SharedRecord } from '@/lib/share'

/**
 * The public recipient page: `/s/<token>`.
 *
 * It is a server component so the record is in the first paint — no client
 * waterfall, no react-query retry storm against an unauthenticated endpoint,
 * and `Accept-Language` is available to decide the chrome's language. The
 * record read is `cache: 'no-store'` (see services/share.ts): a revoked link
 * must stop working on the next load, so nothing may cache this route.
 *
 * The route group `(public)` gives it a root layout with no `AuthProvider`,
 * which is what keeps a recipient from minting a session just by opening a
 * link.
 */
export const dynamic = 'force-dynamic'

interface SharedPageProps {
  params: Promise<{ token: string }>
  searchParams: Promise<{ lang?: string }>
}

async function resolveLocale(searchParams: { lang?: string }): Promise<AppLocale> {
  const [requestHeaders, cookieStore] = await Promise.all([headers(), cookies()])
  return resolveSharedLocale({
    lang: searchParams.lang,
    acceptLanguage: requestHeaders.get('accept-language'),
    cookieLocale: cookieStore.get('NEXT_LOCALE')?.value,
  })
}

export async function generateMetadata({
  searchParams,
}: Omit<SharedPageProps, 'params'>): Promise<Metadata> {
  const locale = await resolveLocale(await searchParams)
  const catalog = sharedViewMessages(locale) as { sharedView: { meta: { title: string } } }
  return {
    title: catalog.sharedView.meta.title,
    // A shared clinical record must never be indexed, and the token must never
    // travel on as a Referer to whatever the recipient opens next.
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  }
}

type RecordLoad =
  | { kind: 'record'; record: SharedRecord }
  | { kind: 'unavailable' }
  | { kind: 'error' }

/** Kept JSX-free and out of the component so the render tree is plain. */
async function loadSharedRecord(token: string): Promise<RecordLoad> {
  try {
    return { kind: 'record', record: await fetchSharedRecord(token) }
  } catch (error) {
    return error instanceof SharedLinkUnavailableError
      ? { kind: 'unavailable' }
      : { kind: 'error' }
  }
}

export default async function SharedRecordPage({ params, searchParams }: SharedPageProps) {
  const { token } = await params
  const locale = await resolveLocale(await searchParams)
  const loaded = await loadSharedRecord(token)

  return (
    <NextIntlClientProvider locale={locale} messages={sharedViewMessages(locale)}>
      <DocumentLang locale={locale} />
      {loaded.kind === 'record' && (
        <SharedRecordView token={token} record={loaded.record} locale={locale} />
      )}
      {loaded.kind === 'unavailable' && <SharedUnavailable />}
      {loaded.kind === 'error' && <SharedLoadError />}
    </NextIntlClientProvider>
  )
}
