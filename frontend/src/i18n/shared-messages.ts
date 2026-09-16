import { messages, type AppLocale } from './messages'

/**
 * The message subset the public share surface is allowed to ship.
 *
 * The recipient page is the one page a person with no account ever loads, and
 * its first 30 seconds are the product. Handing `NextIntlClientProvider` the
 * whole catalog serialises EVERY namespace into the HTML — the sender's own
 * copy, the header menu, the landing page — so a stranger downloads strings
 * about "Sign out" and "Anyone with this link can view your record" on the
 * page where download weight and clarity both matter. This narrows the payload
 * to exactly what the shared tree renders.
 *
 * INVARIANT: if the shared tree starts rendering another component that calls
 * `useTranslations('x')`, add `x` here or that surface renders a raw key.
 * `src/i18n/__tests__/shared-messages.test.ts` pins the set.
 */
export function sharedViewMessages(locale: AppLocale): Record<string, unknown> {
  const catalog = messages[locale] as Record<string, unknown>
  const timeline = catalog.timeline as Record<string, unknown> | undefined
  const misc = catalog.misc as Record<string, unknown> | undefined
  return {
    // The recipient's own chrome and the three states of the link.
    sharedView: catalog.sharedView,
    // The reused full-results table (FlowsheetMatrix).
    timeline: { flowsheet: timeline?.flowsheet },
    // ScaleNote, the reused "converted / not standardised" marker.
    misc: { scaleNote: misc?.scaleNote },
  }
}
