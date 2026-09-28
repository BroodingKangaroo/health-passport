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
  const common = catalog.common as Record<string, unknown> | undefined
  const views = timeline?.views as Record<string, unknown> | undefined
  return {
    // The recipient's own chrome and the three states of the link.
    sharedView: catalog.sharedView,
    // The reused StatusBadge. The flags block must never encode status by
    // colour alone (product plan §4.4), so the recipient's page renders the
    // same word the app does — which means shipping the vocabulary it needs.
    statuses: catalog.statuses,
    // The reused app components the full record renders (ST2): the history
    // list, the entry detail views, the results panel, the flowsheet. Each
    // name here is a namespace one of them calls `useTranslations` with — the
    // list is exactly that set, not a guess, and the pin test keeps it honest.
    timeline: {
      views: { timeline: views?.timeline },
      historyList: timeline?.historyList,
      flowsheet: timeline?.flowsheet,
      resultsPanel: timeline?.resultsPanel,
      biomarker: timeline?.biomarker,
      bloodTest: timeline?.bloodTest,
      doctorVisit: timeline?.doctorVisit,
      instrumentalTest: timeline?.instrumentalTest,
      entrySettings: timeline?.entrySettings,
    },
    // ScaleNote, the reused "converted / not standardised" marker.
    misc: { scaleNote: misc?.scaleNote },
    // One word: TimelineContent's loading line. The shared record is passed in
    // as a prop and never loads, so this branch does not render — but shipping
    // the key means it degrades to the real string rather than a raw key if
    // that ever changes. The rest of `common` stays out: it is the app's
    // "Sign out / Save / Cancel" vocabulary, not a recipient's.
    common: { loading: common?.loading },
  }
}
