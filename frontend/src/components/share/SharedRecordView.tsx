'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslations } from 'next-intl'
import { HeartPulse, Info } from 'lucide-react'

import { LanguageSwitch } from '@/components/share/language-switch'
import { SharedFullRecord } from '@/components/share/SharedFullRecord'
import { SharedSummary } from '@/components/share/SharedSummary'
import { ViewToggle } from '@/components/share/ViewToggle'
import { useSharedFlowsheet } from '@/components/share/use-shared-flowsheet'
import { ViewerProvider } from '@/providers/viewer-provider'
import { formatDate, formatDob } from '@/lib/utils'
import {
  parseSharedView,
  sharedViewHref,
  SHARED_VIEW_PARAM,
  type SharedRecord,
  type SharedView,
} from '@/lib/share'

interface SharedRecordViewProps {
  token: string
  record: SharedRecord
  locale: string
  /** The view the URL asked for; `summary` unless `?view=full` (shared-view plan §1). */
  initialView?: SharedView
  /** The `?lang=` the URL carried, so the language links keep the reader's choice. */
  lang?: string
}

/**
 * The recipient's view of a shared record, and the shell both of its views
 * live in.
 *
 * Two views of one record, chosen by the reader and carried in the URL
 * (shared-view plan §1): the **summary** — the short clinical read, and the
 * default — and the **full record**, which is the owner's own timeline and
 * flowsheet over someone else's data.
 *
 * The record arrives as a prop; only the flowsheet is fetched, lazily, inside
 * the view that needs it. The shell owns what both views share: the record's
 * identity, the language switch, the view toggle (a plain link pair, so it
 * works without JavaScript) and the disclaimer.
 *
 * **One instance of each control.** At `lg` and above the chrome is a sticky
 * rail in the first grid column; below `lg` the same elements are a sticky
 * strip at the top of the page. That is one markup tree, not two: the chrome
 * container is `display: contents` under `lg`, so its children join the page
 * flow directly and the strip's `position: sticky` resolves against the page
 * rather than against a short wrapper. Rendering the chrome twice and hiding
 * one copy with CSS would put two language switches and two toggles in the
 * DOM — invisible to the eye, but not to a screen reader or a test.
 */
export function SharedRecordView({
  token,
  record,
  locale,
  initialView = 'summary',
  lang,
}: SharedRecordViewProps) {
  const t = useTranslations('sharedView')
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'
  const [view, setView] = useState<SharedView>(initialView)
  const stripRef = useRef<HTMLDivElement>(null)
  const [stripH, setStripH] = useState(0)
  // Fetched ONCE, here, and handed to whichever view is showing: the table
  // belongs to both views, and letting each view own the fetch meant one
  // request per Summary ↔ Full record switch (~1.3 MB each, from the backend).
  const flowsheetState = useSharedFlowsheet(token)

  const hrefFor = useCallback(
    (next: SharedView) => sharedViewHref(token, next, lang),
    [token, lang],
  )

  // Switch in place. `pushState` (not `replaceState`) so Back returns to the
  // view the reader came from, and so the URL stays the single source of
  // truth — a reload or a copied link opens the same view.
  const selectView = useCallback((next: SharedView) => {
    setView(next)
    const url = new URL(window.location.href)
    url.searchParams.set(SHARED_VIEW_PARAM, next)
    window.history.pushState(null, '', url)
  }, [])

  // Back/forward must move the view, not just the address bar. The server
  // rendered the view the URL asked for; from here the client keeps them in
  // step.
  useEffect(() => {
    const sync = () =>
      setView(
        parseSharedView(
          new URL(window.location.href).searchParams.get(SHARED_VIEW_PARAM),
        ),
      )
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])

  // The stacked (<lg) full view pins its event switcher under this strip; its
  // height changes when the labels wrap (RU, zoom), so measure it rather than
  // hardcoding an offset — the same pattern TimelineView uses for the app
  // chrome. /demo and the owner's timeline set their own value.
  useLayoutEffect(() => {
    const el = stripRef.current
    if (!el) return
    const measure = () => setStripH(el.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <ViewerProvider capability="shared">
      <div
        style={{ '--chrome-h': `${stripH}px` } as CSSProperties}
        className="min-h-screen bg-background lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start"
      >
        {/* The chrome container. See the component docblock: `contents` below
            `lg` is what lets the strip pin against the page, and it is also
            what keeps one copy of every control in the DOM. */}
        <div className="contents lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:gap-6 lg:overflow-y-auto lg:border-r lg:border-border lg:bg-card lg:px-5 lg:py-6">
          {/* `order-2` at lg: the toggle and the language switch lead the
              mobile flow (a sticky strip) but sit under the record's identity
              in the desktop rail, where there is room for both. */}
          <div
            ref={stripRef}
            data-testid="shared-control-strip"
            className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/95 px-5 py-2.5 backdrop-blur lg:static lg:order-2 lg:justify-start lg:border-b-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none print:hidden"
          >
            <ViewToggle view={view} hrefFor={hrefFor} onSelect={selectView} />
            <LanguageSwitch token={token} locale={locale} view={view} />
          </div>

          <div className="border-b border-border px-5 py-4 lg:order-1 lg:border-b-0 lg:px-0 lg:py-0">
            <div className="flex flex-col gap-1.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <HeartPulse className="size-4 text-primary" aria-hidden />
                {t('orientation.readOnly')}
              </p>
              <h1 className="text-xl font-bold text-foreground lg:text-base">
                {record.header?.name
                  ? t('orientation.ownedBy', { name: record.header.name })
                  : t('orientation.anonymous')}
              </h1>
              {record.header?.dob ? (
                <p className="text-sm text-muted-foreground lg:text-xs">
                  {t('orientation.dob', { date: formatDob(record.header.dob, dateLocale) })}
                </p>
              ) : null}
              <p className="text-sm text-muted-foreground lg:text-xs">
                {t('orientation.lastUpdated', {
                  date: formatDate(record.meta.last_updated, dateLocale),
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('orientation.expires', {
                  date: formatDate(record.meta.expires_at, dateLocale),
                })}
              </p>
              <ScopeNote scope={record.meta.scope} />
            </div>
          </div>

          {/* Section links exist only in the summary: the full record's
              sections are the timeline's own, and it navigates itself. */}
          {view === 'summary' && (
            <nav
              aria-label={t('rail.navigation')}
              className="hidden lg:order-3 lg:flex lg:flex-col lg:gap-1 print:hidden"
            >
              {[
                { href: '#shared-flags', label: t('flags.title') },
                { href: '#shared-trends', label: t('trends.title') },
                { href: '#shared-history', label: t('history.title') },
                { href: '#shared-results', label: t('results.title') },
              ].map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          )}
        </div>

        <div className="min-w-0">
          {view === 'summary' ? (
            <main className="mx-auto flex max-w-3xl flex-col gap-8 px-5 py-6 lg:max-w-5xl">
              <SharedSummary
                record={record}
                locale={locale}
                dateLocale={dateLocale}
                flowsheetState={flowsheetState}
              />
            </main>
          ) : (
            <SharedFullRecord record={record} flowsheetState={flowsheetState} />
          )}

          <footer className="mx-auto max-w-3xl px-5 pb-12 lg:max-w-5xl">
            <p className="flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('footer.disclaimer')}
            </p>
            <div className="mt-4 print:hidden">
              {/* A plain anchor, deliberately NOT a Next <Link>: this href is an
                  API redirect endpoint, not an app route, and a client-side RSC
                  navigation would fire TWO requests at it (the router fetch plus
                  the fallback document load), doubling the S13 counter from the
                  first click. The browser goes straight to /api/share/cta and the
                  backend 302s once. */}
              <a
                href="/api/share/cta"
                rel="noreferrer"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {t('footer.cta')}
              </a>
            </div>
          </footer>
        </div>
      </div>
    </ViewerProvider>
  )
}

/**
 * What this link withholds (Stage 4, S16).
 *
 * Shown to the RECIPIENT, not only the sender: a doctor who cannot find the
 * imaging must be able to tell "the owner did not share it" from "the record
 * has none", and silence would invite the wrong conclusion about the patient.
 * Rendered only when something is actually excluded, so the common case adds
 * nothing to the page.
 */
function ScopeNote({ scope }: { scope: SharedRecord['meta']['scope'] }) {
  const t = useTranslations('sharedView')
  const excluded = scope.exclude ?? []
  if (excluded.length === 0) return null
  const labels = excluded.map((entryType) => t(`excluded.${entryType}`)).join(', ')
  return (
    <p className="text-xs text-muted-foreground" data-testid="share-scope-note">
      {t('excluded.note', { types: labels })}
    </p>
  )
}
