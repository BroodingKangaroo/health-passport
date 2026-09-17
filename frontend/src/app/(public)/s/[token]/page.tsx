import type { Metadata } from 'next'
import { cookies, headers } from 'next/headers'
import { NextIntlClientProvider } from 'next-intl'

import { SharedRecordView } from '@/components/share/SharedRecordView'
import {
  DocumentLang,
  SharedLoadError,
  SharedUnavailable,
} from '@/components/share/SharedStates'
import { SharedUnlockGate } from '@/components/share/SharedUnlockGate'
import { resolveSharedLocale } from '@/i18n/shared-locale'
import { sharedViewMessages } from '@/i18n/shared-messages'
import type { AppLocale } from '@/i18n/messages'
import {
  fetchShareStatus,
  fetchSharedRecord,
  SharedLinkUnavailableError,
} from '@/services/share'
import { sharedFirstPaint, type SharedRecord } from '@/lib/share'

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
 *
 * TWO FIRST-PAINT PATHS since Stage 4 (S15). An unprotected link is read here
 * on the server and arrives in the first paint, exactly as it did in Stage 1.
 * A passcode-protected link cannot be: the request carries no code, so the
 * server would have nothing to render. It asks `/api/share/status` whether the
 * link needs a code and, if it does, renders the prompt and lets the client
 * unlock and fetch the record. The cost of the feature is paid only by the
 * links that opt into it.
 */
export const dynamic = 'force-dynamic'

interface SharedPageProps {
  params: Promise<{ token: string }>
  searchParams: Promise<{ lang?: string }>
}

async function resolveLocale(
  searchParams: { lang?: string },
  defaultLocale?: string | null,
): Promise<AppLocale> {
  const [requestHeaders, cookieStore] = await Promise.all([headers(), cookies()])
  return resolveSharedLocale({
    lang: searchParams.lang,
    defaultLocale,
    acceptLanguage: requestHeaders.get('accept-language'),
    cookieLocale: cookieStore.get('NEXT_LOCALE')?.value,
  })
}

export async function generateMetadata({
  searchParams,
}: Omit<SharedPageProps, 'params'>): Promise<Metadata> {
  // Metadata can only see the URL and the request headers; the link's preset
  // lives inside the record, so a pinned `default_locale` without `?lang=`
  // keeps the pre-record title fallback. DocumentLang fixes `<html lang>`
  // on the client once the record is known.
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
  | { kind: 'protected' }
  | { kind: 'unavailable' }
  | { kind: 'error' }

/**
 * Kept JSX-free and out of the component so the render tree is plain.
 *
 * The status probe runs first: a protected link must render the prompt rather
 * than the dead-link page, and the read that follows (only for an unprotected
 * link) is the same server-side read Stage 1 shipped. The decision itself
 * lives in `sharedFirstPaint()` so it can be unit-tested — a server component
 * is not.
 */
async function loadSharedRecord(token: string): Promise<RecordLoad> {
  try {
    const status = await fetchShareStatus(token)
    const paint = sharedFirstPaint(status)
    if (paint === 'unavailable') return { kind: 'unavailable' }
    if (paint === 'protected') return { kind: 'protected' }
    return { kind: 'record', record: await fetchSharedRecord(token) }
  } catch (error) {
    return error instanceof SharedLinkUnavailableError
      ? { kind: 'unavailable' }
      : { kind: 'error' }
  }
}

export default async function SharedRecordPage({ params, searchParams }: SharedPageProps) {
  const { token } = await params
  const lang = (await searchParams).lang
  // The record can change the answer: the link's own `default_locale` (S10)
  // outranks the browser once we know it. The dead-link/error states have no
  // record, so they resolve without the preset.
  const provisionalLocale = await resolveLocale({ lang })
  const loaded = await loadSharedRecord(token)
  const locale =
    loaded.kind === 'record'
      ? await resolveLocale({ lang }, loaded.record.meta.default_locale)
      : provisionalLocale

  return (
    <NextIntlClientProvider locale={locale} messages={sharedViewMessages(locale)}>
      <DocumentLang locale={locale} />
      {loaded.kind === 'record' && (
        <SharedRecordView token={token} record={loaded.record} locale={locale} />
      )}
      {/* A protected link cannot be read on the server: the prompt is the
          first paint and the client unlocks from the grant it holds. */}
      {loaded.kind === 'protected' && <SharedUnlockGate token={token} locale={locale} />}
      {loaded.kind === 'unavailable' && <SharedUnavailable />}
      {loaded.kind === 'error' && <SharedLoadError />}
    </NextIntlClientProvider>
  )
}
