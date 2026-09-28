# Frontend architecture (HealthPassport)

On-demand companion to AGENTS.md — read this file before touching API
proxying, reference formatting, merge/unit-conflict UI, the settings tab,
the add-entry editor, or the Insights & Correlation view.

## Stack & commands

- Node 22, package manager **pnpm@11.9.0** (enable corepack). Install:
  `pnpm install --frozen-lockfile`. `pnpm-workspace.yaml` only whitelists
  `sharp` builds.
- Next.js 16, `output: 'standalone'`, **images `unoptimized`**, `recharts`
  transpiled.
- Dev: `pnpm dev` (port 3000). Lint: `pnpm lint`. Typecheck: `pnpm typecheck`
  (`tsc --noEmit`). Unit tests: `pnpm test` → `vitest run`, jsdom env, `@/`
  → `src/` alias.
- **No frontend Playwright suite** (removed in the e2e refactor — no
  `test:e2e` script, no `@playwright/test` dep). End-to-end coverage lives in
  the backend golden harness (see `backend/e2e/README.md`).

## API proxying

API calls are proxied server-side via `next.config.mjs` rewrites: `/api/*`
(except next-auth paths) and `/static/*` → `STATIC_PROXY_URL` (default
`http://localhost:8000`, Docker uses `http://backend:8000`). Don't add
client-side API base URLs that bypass this.

This includes the `/api/extract` SSE stream — the rewrite proxies SSE through
incrementally (verified on Next 16 dev + standalone), so `streamApiBase()` in
`services/api.ts` only differs from `API_BASE` when `NEXT_PUBLIC_API_URL` is
explicitly set (direct-origin escape hatch; requires `CORS_ORIGINS` on the
backend to include the site).

**Rewrites only apply to incoming requests.** A fetch the Next *server* makes
does not pass through them, so the public share page
(`src/app/(public)/s/[token]/page.tsx` → `src/services/share.ts`) addresses
`STATIC_PROXY_URL` (default `http://localhost:8000`) directly — the same value
the rewrites use, one line and one comment, not a second API base. Browser-side
calls from that page (the lazy "All results" fetch) still go through `/api/*`
like every other client call.

## Shared view (`/s/<token>`) — the public share surface

A share link is the only surface a person without an account ever sees. It
lives in its own route group and its own root layout, because the authed tree
would otherwise do three things a stranger must not trigger: fetch
`/api/auth/session`, mount the anonymous-session path, and inherit react-query
retries.

- **Route groups.** `src/app/(app)/**` holds every existing page unchanged
  (route groups do not affect URLs); `src/app/(public)/**` holds the shared
  route and supplies its own `<html>`/`<body>`, fonts and `globals.css`
  (which stays at `src/app/globals.css`, imported by both root layouts).
  There is no `src/app/layout.tsx`: Next only drops a parent provider by
  giving a subtree its own ROOT layout. `src/app/api/**`,
  `src/app/global-error.tsx` and the metadata files stay at the app root.
- **No `AuthProvider`** in the public tree — that is the point of the split.
  No `SessionProvider`, no `QueryProvider`, no leave-guard, no toast host.
- **Server-rendered record (unprotected links).** The page is a server
  component that fetches the record with `cache: 'no-store'` and the token in
  the `X-Share-Token` header (`src/services/share.ts`). `no-store` is
  load-bearing: revocation and expiry are evaluated per request on the backend,
  so ANY cache in front of this read would keep a revoked link alive.
  `dynamic = 'force-dynamic'` is explicit for the same reason. A
  passcode-protected link does NOT take this path — see "Two first-paint
  paths" below.
- **Two first-paint paths (Stage 4, S15).** An UNPROTECTED link is read on
  the server and arrives in the first paint exactly as it did in Stage 1. A
  PASSCODE-PROTECTED one cannot be: the first request carries no code, so the
  server would have nothing to render. The page therefore asks
  `GET /api/share/status` (server-side, `shareApiUrl`), and for a protected
  link renders `SharedUnlockGate` — the prompt (`SharedPasscodePrompt`), then
  the client's unlock and record fetch — instead of the record. A dead token
  answers 404 from the same probe and still gets `SharedUnavailable`. The cost
  is paid only by links that opt into a passcode; nothing about the unprotected
  path changed.
- **The grant lives in `sessionStorage`, never a cookie (Stage 4).** After a
  successful unlock the client stores `{token, grant, expiresAt}` under
  `hp.share.grant` (`src/lib/share-grant.ts`). Per-link (unlocking one record
  cannot leak a grant into another opened in the same tab), expiry-checked
  before it is ever sent, and never placed in a cookie or the URL — the share
  surface sets no cookie by contract, and a grant in a query string would land
  in history and `Referer`. Every access is wrapped in try/catch: a sandboxed
  or full `sessionStorage` degrades to "unlock again", not a broken page.
- **A refused read is never cached (Stage 4 review, F2).** The public refusals
  carry the same `Cache-Control: no-store` / `X-Robots-Tag` /
  `Vary: X-Share-Token, X-Share-Grant` set as a successful read (see the
  backend doc), which is what stops the protected flow's second fetch — the one
  carrying `X-Share-Grant` — from being served a cached 404 left by the first.
- **Browser-side share calls are same-origin (Stage 4).** `services/share.ts`
  routes through `shareApiUrl()`: the Next SERVER addresses `STATIC_PROXY_URL`
  directly (the `/api/*` rewrite applies to incoming requests only), while a
  fetch from the recipient's BROWSER must use the same-origin `/api/*` path —
  the proxy origin is a different origin from the page and would be blocked.
  This applies to `unlockSharedRecord`, the gate's record read and the
  flowsheet read, all of which carry the grant in `X-Share-Grant`.
- **Read-only by construction.** The shared tree renders `SharedRecordView`
  (+ the reused `FlowsheetMatrix` and, in the full record, `TimelineContent`)
  and is forbidden from importing `services/api.ts`, `lib/auth-token`,
  `AuthProvider`, `QueryProvider`, `i18n/api-locale`, `next-auth` and
  `recharts`. `src/components/share/__tests__/shared-surface-imports.test.ts`
  **walks the real import graph** from the recipient's roots, resolving `@/`
  and relative specifiers and following `import()` too, distinguishing the
  EAGER graph from what is behind a lazy boundary. Two assertions come out of
  that: nothing forbidden is statically reachable (the recipient's first load
  cannot contain a write path), and the lazily-reachable forbidden edges are
  pinned to an explicit allow-list so adding one is a deliberate edit. The
  walk is why this section is trustworthy — a per-file grep passes the moment
  the offending import sits one file further away, which is exactly how the
  full record's first draft would have shipped `services/api` to a stranger
  (through `entry-settings`) and `lib/auth-token` to every page that formatted
  a date (through `lib/utils`). The reused matrix rows are deliberately inert
  here: `FlowsheetMatrix.onOpenBiomarker` is omitted, so a row is text rather
  than a door into `/details` (the flowsheet view passes the callback;
  `TimelineContent.onViewDetails` uses the same "omitted ⇒ affordance hidden"
  convention).
- **Metadata and headers.** The page sets `robots: noindex, nofollow` and
  `referrer: no-referrer`; `src/app/robots.ts` disallows `/s/`; the API
  responses carry `Cache-Control: no-store` and `X-Robots-Tag`.
- **The recipient's message subset (ST1, widened in ST2).** Recipient copy is
  the `sharedView` catalog plus `statuses` (the flags block spells the status
  out through `StatusBadge`, so colour is never the only channel — §4.4 /
  WCAG 1.4.1), `misc.scaleNote`, and — because the full record renders the
  owner's own components — the `timeline.*` namespaces those components call
  (`views.timeline`, `historyList`, `flowsheet`, `resultsPanel`, `biomarker`,
  `bloodTest`, `doctorVisit`, `instrumentalTest`, `entrySettings`) plus a
  single `common.loading` key. That last one is pinned to exactly that key by
  a test: the rest of `common` is the app's "Sign out / Save / Cancel"
  vocabulary and has no business on a stranger's page.
  `sharedViewMessages()` in `src/i18n/shared-messages.ts` builds that subset and
  `src/i18n/__tests__/shared-messages.test.ts` pins the namespace set, so
  widening it is a deliberate edit rather than an accident. The flags block is a
  row grid at `≥md` (biomarker / latest / range / status) and stays a card stack
  below; names and ranges WRAP there rather than truncating, because a clipped
  "Gamma glutamyl transf…" is unrecoverable on touch and on paper and this block
  is what a recipient prints. The value and the reference render at full
  precision to match the print editor; "What changed" shows the last three
  readings, each dated, with the direction of each step; and reading dates go
  through `formatDay`, not `formatDate` — reading dates are wall-clock text
  stored WITHOUT an offset, so `formatDay` anchors an offset-less string to UTC
  before parsing (a bare midnight parsed locally and rendered in UTC slides to
  the previous day east of UTC), while a string that carries an offset is left
  as the instant it is.
- **Locale.** Resolved by the shared route itself
  (`src/i18n/shared-locale.ts`): `?lang=` → the link's `default_locale` (the
  sender's per-link preset, S10) → `Accept-Language` → `NEXT_LOCALE` → `en`.
  The authed `request.ts` (cookie-only) cannot see a URL parameter, so the
  page wraps its subtree in `NextIntlClientProvider` with the resolved locale.
  The public tree **never writes `NEXT_LOCALE`** — that would change the
  recipient's own app language; the EN|RU switch
  (`src/components/share/language-switch.tsx`) is plain `?lang=` links, and
  the cookie writer (`i18n/api-locale`) is banned from this tree by the import
  graph test. `<html lang>` comes from the layout (layouts never receive
  `searchParams`); `DocumentLang` corrects it when the final locale disagrees.
- **Language of the data is not the language of the chrome.** Biomarker names
  come from the persisted multilingual `names` map, and a public page must
  never fire a translation run (unbounded LLM cost behind a stranger's URL).
- **Narrow layout (S11/S12).** Below the `sm` breakpoint the reused
  `FlowsheetMatrix` renders card-per-biomarker (a matchMedia branch inside
  the shared component, so the owner's flowsheet and `/demo` improve too —
  jsdom and the first paint stay on the wide table). The wide table stays in
  the DOM and prints as a table regardless of the screen breakpoint; the
  language switch and the CTA are `print:hidden`.
- **Print** is the browser's own print over the page (the app's existing
  model): the CTA counts the click via `GET /api/share/cta` (S13) and is
  `print:hidden`, the language switch is `print:hidden`, and the print editor
  is not reachable from this tree.

### Two views, one route (ST2) — summary and full record

The shared route serves ONE record in TWO presentations, chosen by the reader
and carried in the URL: `?view=summary` (the default) and `?view=full`.

- **`?view=` is the whole state machine.** `parseSharedView()` in
  `src/lib/share.ts` is the only place a URL value becomes a view, and
  anything unrecognised falls back to `summary` — the view that stands on its
  own. The server component reads it, so `?view=full` renders the full record
  in the FIRST PAINT with JavaScript disabled, and the same URL is what a
  bookmark or a forwarded link contains. `sharedViewHref()` builds the links,
  and it keeps `?lang=` alongside `?view=` — a reader who switched to the full
  record and then changed language must not land back in the summary.
- **The toggle is a plain link pair.** `ViewToggle` renders two `<a>` elements
  — `<Summary | Full record>` are just links, so the control works before
  hydration and with JavaScript off. With JavaScript the click is intercepted
  and the view swaps in place: no refetch and no scroll reset, because the
  record is already loaded and the flowsheet payload is owned by the shell
  (`useSharedFlowsheet`, called from `SharedRecordView`) rather than by the
  table component each view renders. `history.pushState` keeps the URL in
  step; `pushState` rather than `replaceState` so Back returns to the view the
  reader came from, and a `popstate` listener moves the view when the reader
  uses it. Modified clicks (new tab, save link) are left to the browser.
  (`next/link` is NOT banned from this tree — the language switch uses it. The
  one plain-anchor rule is the footer CTA, and it exists for a different
  reason: it points at an API redirect, and a router navigation there would
  fire two requests and double the click counter. That rule is pinned by a
  source check on `SharedRecordView.tsx`, not by the import-graph test.)
- **Where the toggle sits.** Above `lg` the chrome is a sticky 280px rail in
  the first grid column; below `lg` the same elements are a sticky strip at
  the top. It is ONE markup tree: the chrome container is `display: contents`
  under `lg`, so its children join the page flow and the strip's
  `position: sticky` resolves against the page rather than against a short
  wrapper. Rendering the chrome twice and hiding one copy with CSS would put
  two language switches and two toggles in the DOM — invisible to the eye, not
  to a screen reader or a test. The container also measures itself into
  `--chrome-h`, which is what the stacked full view's event switcher pins
  under.
- **`views/timeline-content.tsx` is the extracted body.** `TimelineContent`
  (the history list + detail panes) moved out of `views/TimelineView.tsx`,
  which keeps only the authed chrome (HeaderBar, NavBar, ShareNotice) and
  re-exports for its existing callers. This is not cosmetic: importing
  `TimelineView` would drag next-auth and `ShareNotice` (which talks to the
  write API) into a stranger's bundle. The moved module takes a `landmark`
  prop (`main` by default, `div` from the full view) because the shared shell
  already provides the page's `<main>` and a nested one is invalid HTML.
- **The viewer capability replaces `isDemo`.** `src/providers/viewer-provider.tsx`
  exposes `owner | demo | shared`; a component that hides a write affordance
  asks which VIEWER it is under, not "is this the marketing page". Components
  that ask: `entry-settings` (renders nothing for a recipient; the danger zone
  and the entry id are the owner's), the three detail views (the document and
  settings tabs are not built for a recipient), and `ExpandedBiomarkerDetails`
  (no charts here; the correlation view is ST3's). Defaults are `owner`, so a
  surface that forgets to wrap its tree keeps full behaviour rather than
  silently losing affordances.
- **The lazy boundaries are load-bearing, and pinned.** Several modules sit
  behind a dynamic import so they stay out of the recipient's eager graph:
  `entry-delete` (the only part of `entry-settings` that reaches the write API
  and react-query's `useQueryClient`, which throws without a provider),
  `@/lib/authed-documents` (imported inside `document-tab`'s handlers — it
  holds the bearer-token document helpers split out of `lib/utils`), and the
  chart modules. `lib/chart-series.tsx` gave up its one runtime recharts
  import (`Curve`) to `lib/chart-line-shape.tsx`: the flowsheet matrix imports
  that module for `coerceChartValue` alone, and the runtime import dragged
  ~350 KB of recharts into the first paint of every page that renders the
  matrix. Its remaining recharts import is `import type`, which TypeScript
  erases — the walker ignores type-only edges for exactly that reason.
- **The shared surface loads no charts at all.** Two changes get it there: the
  the expanded reading row drops its trend chart for a recipient
  (`ExpandedBiomarkerDetails` asks the capability and, since the ST3 review of
  ST2, keeps the heading and the reference line — they label the metric cards
  below, and removing all three left those cards unlabelled), and
  `SharedFlowsheet` passes `showTrend={false}` so the matrix drops its
  sparkline column — `FlowsheetMatrix` gained that prop, defaulting to `true`,
  and it removes one 80px grid track rather than leaving a hole.
- **Measured effect.** The shared page's first-paint script list went from
  1,058 KB across 12 chunks to 797 KB across 14, the 342 KB recharts chunk
  (350,506 bytes) is
  in neither view's server-rendered HTML, and a live run of both views reports
  **zero** nodes matching `[class*="recharts"]` — the charting library is not
  fetched at all, not merely deferred.
- **Layout checks.** No page-level horizontal overflow at 1024 / 1280 / 1440 /
  1920 in either view. Inside the pane, the results table is the one place the
  rail costs something: it takes 280px of the viewport, which leaves the
  detail pane narrower than the owner's, and between `lg` (1024px) and about
  1400px that pushed the table past its pane — at 1280 the table overflowed by
  ~133px and the column that fell off the right edge was **Status**, the
  clinically meaningful one. (Measured against `/demo`, which renders the same
  `TimelineContent` + `ResultsPanel` without a rail: 0px of overflow at 1280,
  against 133px here.) Narrowing the rail is not a fix — 200px still leaves
  717px against a 768px table — so the width comes from the table:
  `ResultsPanel` takes a `minTableWidth` whose default is the capability's
  floor (768px for the owner, 620px for a recipient). The floor only binds
  when the pane is narrower than it, so wider viewports are untouched. Below
  `lg` the shared view is single-column and far wider, so the recipient's
  floor binds only in this one band.

### The full record's correlation section (ST3)

`components/share/SharedCorrelation.tsx` is the only place correlation appears
on the recipient surface, and it appears in the **full record only** — the
summary is the clinical read, and pairs at n ≥ 4 and |r| ≥ 0.5 on a doctor's
first screen read as an assertion (shared-view plan §6). It sits between the
timeline and the table, so it is not buried under the ~9,000px matrix.

- **There is no `/api/share/correlation` endpoint.** The owner's correlation is
  not a server computation: `views/CorrelationView.tsx` renders
  `CorrelationChart` over the biomarkers in the payload and `lib/stats.ts` does
  the arithmetic in the browser. The share record already carries the same
  `biomarkers` array, already narrowed by the same five builders to the link's
  date range and `scope.exclude`. Rendering the owner's own component over it
  makes "the same numbers" structural; a Python twin would be a second
  implementation of the same statistic.
- **The chart is fetched on a click, not on mount.** `next/dynamic` imports its
  target when the dynamic component mounts, so `SharedCorrelation` renders a
  **Show correlation chart** button and mounts the chart only after it is
  pressed. Measured on a production build with network capture at 1280 and
  1024: 14 chunks and **zero** recharts requests before the click; 17 chunks
  and exactly one after. (That chunk is 342 KB / 350,506 bytes. It is
  content-hashed, so its filename changes on every build — the size is the
  stable thing to quote, not the hash.)
- **`hasReadings` is restated here, not imported.** `correlation-chart.tsx`
  exports that predicate, but importing it would pull the chart module — and
  recharts — into the eager graph of the shared tree. The import-graph test now
  lists `components/health-passport/correlation-chart.tsx -> recharts` in
  `ALLOWED_LAZY`; the mock in `shared-correlation.test.tsx` pins that the
  module is not reached before the click.
- **The input is narrower than the owner's by exactly the merged readings.**
  Merged readings never travel (D15), so a merged-only biomarker cannot appear
  on the recipient's chart and a merged reading cannot sit in a correlating
  series. Measured against the live dev record: 160 owner biomarkers vs 131
  shared, all 29 extras merged-only; after dropping merged readings from the
  owner's side the two sets are identical, and both produce the **same pairs
  with the same `n` and `r`**: 346 all-pairs each. The owner's own payload has
  754. Counting only the *suggested* pairs — n ≥ 4 and |r| ≥ 0.5, what the
  panel actually lists — the same three numbers are 161 (owner), 122
  (owner-minus-merged) and 122 (shared). Comparing the owner's 161 with the
  reduced 122, 79 suggestions are gone and 40 new ones appear, and **none of
  those 119 pairs involves a merged-only biomarker**: they are pairs of
  biomarkers present on both sides, whose relationship changes because merged
  readings leave the series. That is the whole difference.
- **Strings.** The section's own framing lives in `sharedView.correlation`
  (EN/RU). The chart is the app's component, so `shared-messages.ts` also ships
  the `correlation` and `charts` namespaces — both views ship them, because the
  provider is page-level, and the pin test in
  `src/i18n/__tests__/shared-messages.test.ts` records the set. Biomarker names
  stay as the owner's record stored them; opening a shared link must never
  trigger a translation run.
- **The chart's confidence verdict is withheld from a recipient (ST3 review).**
  The owner's panel prints `Strong positive · 7 readings · likely a real
  relationship` and the legend explains the 5% threshold behind that phrase. A
  shared link must not: the panel ranks pairs by |r|, so the threshold is never
  corrected for that selection, and a clinician reads it as an assertion. For
  `viewer.capability === 'shared'`, `confidenceLabel` returns
  `correlation.confidence.exploratory` — "exploratory: 7 shared readings" —
  which names the sample size itself, so the separate readings slot is dropped
  on that branch (the row's `title` uses `topPairs.rowTitleExploratory` for the
  same reason), and `CorrelationLegend` omits the threshold sentence
  altogether. The section's framing paragraph and the page's not-a-diagnosis
  line are unchanged. The owner's view is untouched; pinned by
  `components/__tests__/correlation-confidence.test.tsx`, which renders both
  capabilities.
- **`useChartAxisMode` writes `hp.chartAxisMode` to localStorage** when a reader
  presses "Even spacing". That is a preference on the recipient's own machine,
  written only in response to their click; the shared surface still sets no
  cookie and keeps no view state outside the URL.

### Sender surfaces (Stage 2) — dialog, card, notice

Three sender-facing pieces, all under `components/share/sender/` (that
directory is the OWNER's half and is excluded from the read-only import
graph). Copy for them lives in the `share` catalog (sender) — never in
`sharedView` (recipient).

- **Create dialog** (`share-link-dialog.tsx`, opened by the header's "Share a
  link" button): scope (whole record, or a `range` with either end optional),
  expiry (1/7/30 days) and the personal-header checkbox, defaulting ON. The
  raw token appears exactly once, right after creation; reopening the dialog
  clears it. Entry notes never travel — there is no notes toggle. An
  **anonymous** sender is offered 1 or 7 days only, plus the cookie warning
  (clearing the browser data loses the ability to revoke), because the server
  refuses 30 days for that principal (S4): the UI and the cap must agree. The
  dialog creates only — managing and revoking lives in the card below.
- **"Shared links" card** (`share-links-card.tsx`) on `/settings`: every link
  the sender ever created, newest first. It renders the **server-computed**
  `state` (`active`/`expired`/`revoked`) and `has_new_data` verbatim — the
  client never derives validity from the dates — plus the scope in words
  (`Whole record`, `{from} – {to}`, `From …`, `Until …`), the expiry, the
  opened state from `open_count`/`last_opened_at` ("Opened # times · last
  …", singular for 1, "Not opened yet" for 0), a per-row Revoke for active
  rows, and a Popover-confirmed Revoke all that only exists while something is
  active. Scope dates are whole days, parsed as LOCAL midnight so a positive
  UTC offset cannot shift the day or add a time. Like `usage-card`, the first
  read is gated on `useAuthPrincipal().authReady`.
- **New-data notice** (`share-notice.tsx`) mounted in `TimelineView` between
  the sticky chrome and `TimelineContent` — NOT inside `TimelineContent`, so
  the `/demo` surface (which renders `TimelineContent` directly) never asks
  about links. It renders a quiet `print:hidden` band only while
  `GET /api/share/notice` answers `show: true`, reads once per mount, and
  acknowledges with an explicit `POST /api/share/notice/ack` (never as a
  side effect of the read); a failed ack keeps the line. A failed read stays
  silent.

API shapes live in `lib/share.ts` (`ShareLinkSummary` with `state`,
`has_new_data`, `open_count`, `last_opened_at`; `ShareLinkCreateInput`;
`ShareNotice`) and the four `*ShareLink*`/notice functions in
`services/api.ts`, all through the `/api/*` proxy with `credentials:
include`. The old client-side `shareLinkState()` helper is gone.

## Landing gate (`/`, zero-entries hero)

- `/` (`src/app/page.tsx`) renders `LandingGate`
  (`src/components/landing/landing-gate.tsx`): a **client-side gate** — no
  middleware — that shows the marketing hero (`landing-hero.tsx`) only when
  the timeline query resolved without error AND returned zero events;
  otherwise (loading, error, any entries) `TimelineView` renders as before,
  with its own loading/error states. A user with data therefore never sees
  the hero.
- The gate depends on the timeline cache being fresh at mount. Saving the
  first entry on `/add-entry` REFETCHES `['timeline']`
  (`refetchQueries`, not just `invalidateQueries` — there is no active
  observer there, so an invalidate would leave a stale zero-entry snapshot
  that the gate would misread as "first visit"). Don't downgrade that back
  to `invalidateQueries`.
- Hero copy lives in the `landing` i18n catalog (`src/i18n/messages/landing.ts`,
  EN/RU parity test). The trial-extraction count is interpolated from
  `/api/usage/limits` (`ai_extraction_limit`, fetched pre-auth — the backend
  creates the anon session on demand); it falls back to 5 on fetch failure,
  matching `ANONYMOUS_LIMITS` in `backend/config.py`. If that backend limit
  changes, only the fallback needs updating.
- The hero is session-aware via `AuthStatusProvider`: authenticated
  zero-data users get "Add your first entry" instead of the trial CTAs.
- The hero CTAs: primary "Try without account" → `/add-entry`; secondary
  "See live example" → `/demo`.

## Demo surface (`/demo`) and privacy page (`/privacy`)

- `/demo` (`src/app/demo/page.tsx` → `DemoTimelineView`,
  `src/components/landing/demo-view.tsx`) is the roadmap's "show, don't ask
  for trust" surface: the REAL timeline components
  (`TimelineContent`, split out of `TimelineView` in
  `src/views/TimelineView.tsx`) rendered from a fully **fictional** fixture
  (`src/demo/demo-data.ts`, `buildDemoTimeline(locale, now?)`). No API
  calls, no session state, no persisted data, no backend involvement.
- The fixture is a fictional patient: authored values (status mix: interval
  low/normal/high + qualitative normal/abnormal), fictional
  clinic/doctor/narrative, bilingual definition names, day-offset dates
  relativized at render (never ages). Qualitative `value`s use the backend's
  canonical English enum ("Detected"/"Not detected"); raw RU document text
  lives in `original_*`. Entry fields mirror the extraction save path
  (`status: 'Completed'`, `category: 'Labs'`, `source_language: 'ru'`).
  `src/demo/__tests__/demo-data.test.ts` asserts status↔reference
  consistency and that all statuses are exercised.
- `DemoModeProvider` (`src/providers/demo-provider.tsx`) marks the surface.
  Real components check `useDemoMode().isDemo` to hide stateful affordances
  that have nothing to act on: `entry-settings.tsx` hides the delete danger
  zone. `TimelineContent.onViewDetails` is omitted on `/demo`, which hides
  the expanded-row "View full details" button
  (`expanded-biomarker-details.tsx` renders it only when the handler is
  set) — the fixture has no backing `/api/biomarker` payload. NavBar /
  flowsheet / correlation are not rendered on the demo header for the same
  reason.
- The banner explains the fictional data and carries the conversion CTA
  ("Upload your first document" → `/add-entry`, anonymous trial). Demo copy
  lives in the `demo` i18n catalog.
- `/privacy` (`src/app/privacy/page.tsx`, roadmap 0.2) is a server-rendered
  localized privacy policy (content in the `privacy` i18n catalog), linked
  from the landing footer and the settings page. Shipping demo traffic is
  gated on this page being live (roadmap sequencing rule).

## Event-type visual language (timeline scannability, roadmap 0.6)

- `src/lib/event-visuals.ts` (`TYPE_VISUALS: Record<EventType, …>`) is the
  single source for event-type → presentation (icon, color classes, i18n
  label key), mirroring the `status-labels.ts` precedent. Consumers:
  `history-list.tsx` (icon bubbles, chronology rail nodes, filter chips,
  popover type rows), the three detail views (identity chip next to the tab
  strip), and `entry-settings.tsx` (type row icon).
- **Channel contract** (also documented on the module): type colors are
  CATEGORICAL and paint only icon bubbles, rail nodes, filter-chip dots, and
  header chips — never status-bearing text. Status colors (`STATUS_TEXT_CLASS`,
  Badge variants) are SEMANTIC (low/high/abnormal). The primary accent is
  INTERACTION (selection/hover/focus). Type is always encoded by icon shape +
  label, never color alone. `src/lib/__tests__/event-visuals.test.ts` guards
  this structurally (distinct tokens, no `status-*` collision).
- Color tokens are CSS vars in `globals.css` (`--event-<type>[-bg]`, teal /
  indigo / violet / rose) defined under `:root`, `.dark`, AND the
  `prefers-color-scheme: dark` fallback block — all three must stay in sync.
  The same change added the previously missing `.dark` overrides for the
  `--status-*` tokens.
- The chronology rail in `history-list.tsx` is a quiet hairline spine with a
  solid type-colored node per event (no icons inside nodes); the selected
  node gets an accent ring — selection is never a type color.
- Filter chips (All + per type, colored dot + count) double as the visual
  legend; counts are computed over ALL events, not the filtered set.
- Procedures have no dedicated detail view; `TimelineContent` renders them as
  a minimal type-chip summary card (title/date/clinic) instead of the generic
  "no detail view" stub — the /demo surface includes a procedure event, so
  the stub would otherwise be a visible dead end on the marketing surface.
- **Print editor (future change — do not forget):** the event-type colors are
  intentionally NOT applied to the printed passport / print editor; the
  printed document keeps its own neutral, language-independent layout (its
  7-language maps are document-language, not UI locale). If/when the print
  editor is redesigned, consciously decide whether type colors carry over —
  until then, keep print styling free of `event-*` tokens.

## Print/export translation flow

- `print-setup.tsx` "Generate Document" actually performs its promised AI
  translation: in `translate`/`bilingual` mode with a non-`en` target it
  fetches the flowsheet matrix and calls `POST /api/translate-biomarkers`
  (one batched LLM call per language). While it runs, the button shows a
  spinner with live elapsed seconds ("Translating terminology… Ns") so the
  AI call never feels stuck; the client-side patience cap lives in
  `TRANSLATE_TIMEOUT_MS` in `services/api.ts` (see below; a retry is cheap —
  already-translated names short-circuit server-side).
- The response's per-item `source` (`translated`/`cached`/`fallback`, see
  `backend/docs/architecture.md`) drives the UX: any fresh translations open
  a review dialog (`translation-preview-dialog.tsx`) listing each English →
  translated pair under a "Name used in document" header, with a per-term
  `Translation | English` toggle — active on fresh translations, rendered
  locked on cached/kept-as-is rows (locked to Translation); fallback rows
  have no toggle — the amber "English fallback" label sits in the choice
  column instead; the row always shows the name that will actually print. The dialog is naming-only — it never removes a biomarker from the
   document (exclusion lives in the print editor filter), and a footer hint says
   so. Confirming commits ONLY the terms left on `Translation`
   (`commitTranslatedNames` → `POST /translate-biomarkers/commit`, no LLM/quota)
   and navigates to `/print-editor`; "Back" discards the whole run without
   saving anything (a re-generate then re-translates at LLM cost) — Escape
   and a click on the dimmed backdrop discard identically to Back, while
   clicks inside the dialog panel are ignored. A success
  toast states how many terms were saved for future documents. Badges
  distinguish `cached` ("already translated"), `fallback` ("English fallback"
  — a failure), and names the model deliberately returned unchanged — Latin
  terms, acronyms, proper nouns (`translated` but identical to the input,
  badged "kept as-is"); a two-row legend explains both. An all-`cached`
  response skips the dialog entirely — re-generates of an already-translated
  document are instant and free.
- The backend persists translations into the definition's `names[lang]`
  column (see `backend/docs/architecture.md`), so `print-editor.tsx`'s
  `translatedName()` — which reads `def.names[lang]` via the flowsheet's
  per-definition `names` — renders them with no renderer changes.
- **Category/panel headings** are translated in the same batch (sent as
  `opts.categories`, deduped distinct non-empty matrix headings) but never
  written to the definitions: the backend serves repeat headings from a
  shared server-side cache (only genuinely new strings reach the LLM; a
  fully-cached document generates free). The returned map lands in
  `PrintConfigProvider`
  (`categoryTranslations`) and sessionStorage (`hp-cat-translations:<lang>`)
  so refreshing `/print-editor` keeps translated headings; changing language
  re-hydrates from that language's key. The map is keyed by each **raw**
  matrix heading (the editor looks categories up verbatim; the API is keyed
  by their trimmed form). The review dialog shows them
  read-only under "Panel headings (applied automatically)" — they are
  structural groupings, always applied. `print-editor.tsx`'s
  `categoryLabel()` resolves the display label only — grouping/order keys
  stay the raw string; untranslated headings fall back to it. A failed run
  keeps whatever was previously stored for that language.
- Translation failures never block export. On a failed run
  `PrintConfigProvider.suppressSavedTranslations` is set for this navigation
  so `print-editor.tsx` renders the English / source names and raw category
  headings even though saved translations exist on the definitions — honoring
  the "fallback to English" contract. A successful run (or a language switch)
  clears the flag. The failure toast is sticky (`duration: Infinity`) with a
  close button, and
  tells the user the document is in their source language and how to retry,
  so it survives switching tabs. The `original` mode (labeled neutrally
  "Keep Original" — source documents are not necessarily Russian) and the
  `en` target skip the translation call entirely. Client-side patience is
  bounded by `TRANSLATE_TIMEOUT_MS` (150s) in `services/api.ts` — generous
  because the LLM can take well over a minute under load, but capped so the
  UI can't hang forever.
- **Every programmatic exit goes through `exitToEditor()`**, which tears the
  leave-guard down with `disarm({ pop: false })` — deliberately WITHOUT
  popping the history marker — before `router.push('/print-editor')`. Any
  marker pop is forbidden on this path: `history.go(-1)` delivers its
  `popstate` asynchronously, i.e. INTO the in-flight Next.js soft
  navigation, which treats the popstate as a newer navigation intent and
  aborts the pending push — the user stays on `/print-setup` ("the editor
  never opens", seen after a failed run or an all-cached regeneration).
  Order doesn't help; popping must simply not happen. The leftover marker is
  harmless (see leave-guard section): it is absorbed silently by the always-
  on `popstate` handler. The review dialog's confirm path navigates long
  after teardown (plain `disarm()` ran when results arrived), so only the
  three programmatic paths (all-cached shortcut, empty-names branch, failure
  fallback) go through `exitToEditor()`; the `finally` block is just a
  safety net for the aborted-leave path.

## Navigation leave-guard during AI processes

- `LeaveGuardProvider` (mounted in `app/layout.tsx`) prevents accidentally
  abandoning a running AI process. Two call sites arm it: add-entry while
  `uploadState === 'scanning'` (extraction), and print-setup during the
  in-flight translation network call only — once results are back, leaving
  during the review dialog loses nothing (nothing is persisted until
  confirm), so the guard is disarmed there.
- While armed, the browser Back button pops an invisible same-URL history
  marker (`popstate` interception) instead of leaving, reload/close goes
  through `beforeunload`, and every in-app navigation (NavBar tabs,
  HeaderBar buttons, view Back buttons) routes through `confirmLeave()`,
  which shows a styled "Leave while AI is working?" alertdialog.
- Confirming leave fires the process's `arm(message, onLeave)` callback,
  which aborts the in-flight request (AbortController) BEFORE navigating so
  a stale completion can never hijack navigation (e.g. into
  `/print-editor`); the   aborted path stays silent — no toast, no push.
  Choosing "Stay" — or clicking the dimmed backdrop outside the dialog
  panel; clicks inside the panel are ignored — keeps the marker pushed for
  the next Back press.
  `disarm()` is idempotent and by default pops the marker; both
  confirmed-leave and natural completion converge through it. Callers that
  navigate programmatically right after teardown must instead use
  `disarm({ pop: false })` — the marker's `history.go(-1)` delivers its
  popstate into the in-flight soft navigation and aborts it
  (print-setup's `exitToEditor()` is that contract) — and the guard cleans
  up after them: `arm()` never stacks a second marker when the top entry is
  already one, and the (now always-on) `popstate` handler consumes stale
  markers silently, one invisible hop per Back press, whenever the guard is
  disarmed.

## Reference formatting / stats

Mirror of the backend's reference model (see `backend/docs/architecture.md`):

- `frontend/src/lib/reference.ts` — `formatReference`, `intervalBounds`,
  `isOutsideReference`.
- Manual entry sends a structured `reference` object per row (not a range
  string); `frontend/src/components/health-passport/reference-input.tsx` is
  its interval editor.

## Display-time RU translation (qualitative values + units)

Stored data is ALWAYS canonical English — reading values, `reference.expected`
and `canonical_unit`/`unit`. Status computation (save-time, backend),
`isOutsideReference`, `qualitativeToNumber`, matching and sorting all compare
stored strings, so translation happens only at render sites:

- `src/lib/qualitative-labels.ts` — the backend's closed qualitative enum
  (`normalize_qual`: Negative, Positive, Detected, Not detected, Absent,
  Present, Normal, Abnormal) mapped to neutral Russian forms plus the
  "Qualitative"/«Качественный» unit-column word. `qualitativeLabel(value,
  lang)` matches canonically and EXACTLY (case-sensitive); raw document text,
  already-Russian strings and formatted numbers pass through untouched. These
  are domain/document terms — deliberately NOT in the next-intl catalogs
  (same policy as the print editor's own language maps).
- `src/lib/unit-labels.ts` — curated static EN→RU dictionary for the dominant
  canonical units (`mg/dL`→`мг/дл`, `copies/mL`→`копий/мл`, `10*3/uL`→
  `×10³/мкл`, …). Matching normalizes case/`µ`/whitespace; the UCUM long tail
  (`[arb'U]/mL`, `{score}`-style oddballs beyond the curated set) passes
  through verbatim. Units are precision-critical — NEVER route them through
  an LLM translation.
- `formatReference(ref, unit, { full?, lang? })` translates a qualitative
  expected text via `qualitativeLabel` and, for `lang: 'ru'`, the interval
  unit suffix via `unitLabelRu`. `unitLabel(unit, ref, lang = 'en')` localizes
  both the Qualitative word and the unit. Callers pass `useLocale()` (UI) or
  the print editor's document `lang` — only the `ru` maps hit; every other
  language is a passthrough, so all EN-default tests are unchanged.
- Wired render sites: `results-panel` (value/unit/reference cells — but its
  `unitKeyOf` sort key must stay canonical, i.e. call `unitLabel` WITHOUT
  `lang`), `flowsheet-matrix` (cells + reference tooltip), `biomarker-details`
  (+ share text), `expanded-biomarker-details`, `biomarker-combobox` range
  hint, `LabResultForm` qualitative dropdowns (`<option value>` stays the
  canonical enum; only the visible label translates),
  `unit-combobox` (display-only localization in the unit picker: the
  'Qualitative' sentinel renders «Качественный» and, in RU, known units
  render Russian — the sentinel string and the row's stored/typed value are
  still compared/used verbatim; search and "add new" operate on the
  canonical text. `unit-conflict-dialog` keeps `rawUnit`/`standardUnit`
  verbatim on purpose — they show exactly what is stored and compared),
  `print-editor` (cells + reference line, document-language driven).

## Insights & Correlation view

- `views/CorrelationView.tsx` → `components/health-passport/correlation-chart.tsx`.
  The view is a full-height flex column (`h-screen`); the chart grid is
  `h-[calc(100vh-220px)]`, so the two cards stay equal height with room to
  breathe.
- The left card has two tabs: **Top correlated pairs** (default) and
  **Select biomarkers**. The pairs list is ranked by `|r|` (strongest first,
  ties by sample size), scrolls to fill the card, and is auto-selected on
  load; clicking a row applies that pair, highlighted in the list.
- Correlation math lives in `frontend/src/lib/stats.ts` (pure, unit-tested):
  Pearson `r`, two-sided p (t-test, n−2 df, via Lanczos lnΓ + incomplete
  beta), `pairwiseCorrelations` over index-aligned normalized series (null
  slots for missing dates; pairs with < 2 co-present points or zero variance
  are omitted).
- Values are normalized to a 0–100 scale in `correlation-chart.tsx`
  (`normalizedValue`, exported for tests): interval → `(v−low)/(high−low)·100`,
  one-sided → percent of the bound, exact (low=high) → percent of the expected
  value, qualitative 0/1 → 0/100. A zero bound at 0 (e.g. `{low: null,
  high: 0}` "nothing expected" references) can't scale proportionally, so it
  maps binary: at the bound → 0, any excess → 100 — this keeps all-zero
  readings (blasts, plasma cells, …) chartable instead of producing NaN.
- Suggested-pair threshold: **n ≥ 4 shared readings and |r| ≥ 0.5** — the
  n≥4 floor keeps tiny samples (where a perfect fit is trivial) from flooding
  the list with spurious r = ±1.
- Confidence is shown in plain language, never p-values: p < 0.05 →
  "likely a real relationship", else "could still be chance", n < 3 → "too
  few readings to tell".

## AI-guessed unit UI
- A unit cell whose canonical unit was LLM-invented (`canonical_unit_inferred`)
  is flagged only in the **add-entry editor** (`LabResultForm.tsx`): blue
  ring/glow (`ring-2 ring-blue-400/80 bg-blue-50/60 shadow…`) plus an instant
  CSS hover tooltip ("Unit guessed by AI — verify").
- The old amber `InferredUnitNote` triangle was **removed** from the timeline
  (`results-panel.tsx`) and flowsheet (`flowsheet-matrix.tsx`) — do not re-add
  it there.

## Unit-conversion decision dialog

- After `/api/extract`, `AddEntry` scans returned biomarkers for
  `scale_function` (a cross-scale conversion was applied because the doc unit
  differed from the existing canonical). If any exist, `UnitConflictDialog`
  (`unit-conflict-dialog.tsx`) lists them with per-biomarker choice "Use
  converted value" (default) vs "Keep document unit" (warns the biomarker
  graph becomes unusable).
- "Keep document unit" rewrites the form row back to `raw_value`/`raw_unit`;
  it does NOT change the stored definition's canonical unit.

## Extraction failure retry

- When `/api/extract` fails (OCR/LLM error), `AddEntry` falls back to manual
  entry but keeps the selected file, showing a **"Try again"** button in the
  error banner (`runExtraction(selectedFile)` re-runs the whole SSE flow) and
  a **remove (✕)** control on the document preview so a failed file can't be
  silently attached on Save. `removeFile()` clears both `selectedFile` and the
  hidden `fileRef` input, else Save re-attaches via the `fileRef` fallback.
- Removing the document never dead-ends: an empty preview slot shows the
  click-to-attach prompt in every mode (`DocumentPreviewPane`). Picking a
  file there attaches it via the hidden `fileRef` input. In AI mode it then
  re-runs the full SSE extraction (a fresh start, exactly like the dropzone)
  — behind an `ExtractionConfirmDialog` whenever the form currently holds
  data a fresh extraction would wipe (`hasFormData`: filled biomarker rows,
  or extracted visit/instrumental content); an empty form extracts
  immediately. Cancelling keeps the new file attached and the current form
  data intact. Manual mode keeps plain attach-only semantics.

## Merge UI + merged-readings sections

- `AddEntry` (`add-entry.tsx`) shows a merge checkbox when another blood test
  exists on the same date (target dropdown when several exist). Conflicts are
  detected client-side by definition_id/LOINC **and by name** (mirroring the
  server's name-based resolution of manually-typed rows); the checkbox
  auto-unchecks when a conflict appears so saving can never silently create a
  duplicate entry.
- Merged readings show up **only in the timeline details view**
  (`results-panel.tsx`), grouped under a `MergedSectionHeader` describing the
  second upload (title · time, clinic · provider, "Added from a later upload
  on the same date"); the flowsheet and print editor don't show them.
- `biomarkersAtDate` (`views/TimelineView.tsx`) matches readings by
  **`entry_id`** — every `Reading` and `BiomarkerResult` carries the medical
  entry it belongs to, so two unmerged tests on the same date select their own
  values/flags instead of the first date-match. It then copies
  `merged`/`merged_source` from the reading AT the selected event
  (`isLatest`-gated, per-reading flags) — never a `??`-fallback to the latest
  reading's flags. The same `isLatest`-gated copy applies to
  `original_name/value/unit/range`, `reference`, and (ISSUES.md #68)
  `scale_function`/`needs_review` — the top-level `BiomarkerResult` carries
  the latest reading's scale/review flags so the selected event's chip
  renders its `ScaleNote` like every history reading. The history-list "abnormal only" filter matches the
  same way (`entry_id === event.id`).

## Instrumental-test entries

- `add-entry.tsx` offers the third AI document type, `instrumental_test`
  ("Instrumental Test (MRI, Elastography, ECG...)"). Extracted
  `instrumental_data` is edited in `InstrumentalTestForm.tsx`, whose
  `MODALITIES` select is the **fixed** list — MRI, CT, X-Ray, Ultrasound,
  Elastography, Mammography, PET Scan, ECG, Endoscopy, Other — the backend
  extractor is constrained to the same values.
- Biomarker rows belong to blood tests only: `buildSaveEntryFormData` sends
  `biomarkers` only when `documentType === 'blood_test'`, and the Document
  Type select's `handleDocumentTypeChange` clears stale extracted
  categories/visit/instrumental state, so a switched entry can never persist
  leftover readings or the wrong structured payload.
- Timeline details: `TimelineView` renders `InstrumentalTestDetails.tsx`
  (modality, findings, conclusion, attachments, Settings tab with Delete) for
  `instrumental_test` events, fed from the timeline response's `instrumental`
  map keyed by entry id.

## Auth pages & password reset

- Public pages under `src/app/`: `login`, `register`, `forgot-password`,
  `reset-password`, `confirm-email-change`. No middleware guards routes; auth
  is enforced server-side via `get_current_user_or_anon` on data endpoints.
- `/forgot-password` posts to `/api/auth/forgot-password` (proxied); on success
  it shows a static confirmation (the backend never reveals whether the email
  exists). `/reset-password` reads `?token=` from the URL, validates a new
  password client-side (min 8 chars, mirroring register), posts to
  `/api/auth/reset-password`, and offers a link back to `/login`. Both pages
  follow the login/register Card layout and go through the server-side proxy.
- `/confirm-email-change` reads `?token=` and **confirms on an explicit button
  click, not on mount** — the token is single-use, and a mail scanner or link
  preview fetching the page must not be able to consume it. Missing token →
  invalid-link state; success → "email updated" + a button to `/login`.
- **Dead backend tokens land on `/login`** (roadmap 0.4). A 7-day JWT can be
  retired server-side at any time (password change, password reset, confirmed
  email change), while NextAuth's session cookie still looks valid. The
  backend is the source of truth: `AuthStatusProvider` verifies the token
  against `GET /api/auth/me` on mount, and `services/api.ts` exposes
  `setUnauthorizedHandler` — a single hook (registered once by the provider)
  that every fetch wrapper calls through `apiError()` on a 401 **that carried
  a bearer token** (a tokenless 401, e.g. a wrong-password login, must not fire
  it). Both paths `signOut({ callbackUrl: '/login?session=expired' })`, and the
  login page renders `login.sessionExpired` for that query param, so the user
  learns why they are back at a login form. The hook fires at most once per
  token, so parallel react-query failures do not sign out repeatedly. Sibling
  services (`import-jobs.ts`, `notifications.ts`) route their `parseError`
  through the same helper.
- **Honest delivery state**: `/forgot-password` and the settings email-change
  form both use `useEmailDeliveryEnabled()` (`src/lib/hooks/`), which probes
  `GET /api/auth/email-delivery`. When the instance has no SMTP transport they
  show `emailDeliveryWarning` instead of promising an inbox that will stay
  empty — the backend's uniform 200 (anti-enumeration) cannot report a
  per-address failure, so instance capability is the only honest signal.
  `null` (probe pending or failed) stays silent rather than warning on a guess.

## Settings tab

- `frontend/src/components/health-passport/entry-settings.tsx` — third tab
  inside `BloodTestDetails` and `DoctorVisitDetails` (next to Documents).
- Surfaces entry-level stats (type, date, age, document count + total size,
  biomarker counts by status for blood tests, notes/Rx/recommendation counts
  for visits, copyable entry ID) and a Danger Zone with a destructive Delete
  button + Radix Popover confirm dialog.
- The view-level `TimelineView` passes an `onDeleted` callback that clears the
  local selection and refetches the timeline.

## Settings page (`/settings`, Account & Data)

- `views/SettingsView.tsx` composes five cards: `profile-card`, `usage-card`
  and the danger zone from `components/health-passport/settings/`, plus the
  data-export card and `components/share/sender/share-links-card.tsx` (the
  sender's link history — see "Sender surfaces" below). Entry point: a **Settings** item in
  the header user dropdown (`header-bar.tsx`, next to Sign out — registered
  users only; anonymous sessions have no dropdown and reach `/settings` by
  URL). The view has a ghost "Back to Dashboard" sub-nav bar (reusing
  `misc.backLinks.dashboard`, leave-guard routed, same pattern as
  `PrintSetupView`), and the header logo block is a button that navigates
  to `/` through the same leave-guard (`header.home` aria-label).
- Auth state comes from `AuthStatusProvider` via the view — cards receive
  `status`/`user`/`anonId` as props (no context lookups inside cards, so
  tests render them directly without provider mocks).
- **Profile card**: registered → name/email/dob/gender rows (gender labels
  reuse the `header.gender*` keys); anonymous → explainer + Register CTA
  (router.push — this project's `Button` has no `asChild`) + session id.
  The email row carries a **Change** toggle that reveals an inline
  email-change form (`changeEmail(password, newEmail)`): new address + current
  password, submitting to `POST /api/auth/change-email`. The card reports only
  "confirmation link sent to {email} — your address stays {current} until you
  open it", because the backend switches the address only when that link is
  followed (double opt-in). Backend refusals (wrong password, throttled, own
  address) surface inline through `ApiError.message`. Anonymous sessions get no
  email affordance. The one refusal that does NOT surface is a taken address:
  the backend answers a uniform 200 there (a 409 used to be an enumeration
  oracle), so the caller sees the same "link sent" note and the message simply
  never arrives — the deliberate anti-enumeration tradeoff, identical in spirit
  to forgot-password's uniform 200.
- **Usage card**: renders `fetchUsageLimits()` — AI extractions and storage
  as progress bars ("{used} of {total} used", `Limit reached` when a meter is
  exhausted). This is the ONLY place quota is surfaced proactively; upload
  flows still learn limits reactively via 429 toasts. `formatBytes` is
  shared from `entry-settings.tsx` (exported there).
- **Data-export card**: `downloadAccountExport('json' | 'csv')`
  (`services/api.ts`) — authenticated fetch of `GET /api/export` through the
  proxy (a plain anchor cannot send the Authorization header), then blob →
  anchor download. Filename from the backend's `Content-Disposition`, else a
  dated fallback (`healthpassport-backup-YYYYMMDD.json` /
  `healthpassport-readings-YYYYMMDD.csv`). Errors toast via sonner.
- **Danger zone card**: registered users get the change-password form
  (client-side mismatch + ≥8-char checks mirroring register/reset; backend
  errors surface through `ApiError.message` — the server's localized
  detail). A successful change bumps the account's session version server-side,
  so this tab's own token is dead: the card toasts and then deliberately
  `signOut({ callbackUrl: '/login?session=expired' })` rather than waiting for
  the next request to 401. Registered users also get a Popover-confirmed
  **Delete account** (same destructive
  pattern as `entry-settings.tsx`) which calls `deleteAccount()` then
  `signOut({ callbackUrl: '/' })`. Anonymous users see only session-data
  deletion, which ends with `window.location.assign('/')` — a full reload
  onto the fresh anonymous session the backend's cookie-clear provides.
- i18n: the `settings` tree lives in `src/i18n/messages/settings.ts`
  (en/ru parity auto-guarded); the header gear label is `header.settings` in
  `shared.ts`. Tests: `src/components/__tests__/settings-cards.test.tsx`
  (mocks `@/services/api`, `next-auth/react`, `next/navigation`) and
  `src/services/__tests__/export-download.test.ts`.

## UI localization EN/RU (next-intl, cookie-driven)

- **No URL-based locale routing.** The locale lives ONLY in the `NEXT_LOCALE`
  cookie (`en` | `ru`), read server-side by `src/i18n/request.ts`
  (registered via `createNextIntlPlugin` in `next.config.mjs`). First visit
  sets the cookie from `navigator.language` (inline bootstrap script in
  `app/layout.tsx`, which reloads once when a Russian browser lands on the
  English-rendered page). `app/layout.tsx` also drives `<html lang>` and the
  message set from the cookie; all routes are therefore Dynamic.
- `LanguageSwitch` (`src/components/shared/language-switch.tsx`, `EN | RU`)
  sits in the header bar and on all four auth pages. It writes the cookie via
  `setLocaleCookie()` in `src/i18n/api-locale.ts` and calls
  `router.refresh()` — the server tree re-renders with the new locale while
  client state survives.
- Message catalogs: per-domain TS modules in `src/i18n/messages/`
  (`shared/auth/addEntry/timeline/correlation/print.ts`, plus `sharedView.ts`
  for the recipient and `share.ts` for the sender), each exporting
  `{ en, ru }` trees merged by `index.ts`. RU plurals use ICU
  one/few/many/other with the `count` param. `src/i18n/__tests__/messages.test.ts`
  guards en/ru key parity, non-empty values, and param consistency.
- **The public share route is the exception**, and only about WHERE the locale
  comes from: `src/i18n/shared-locale.ts` adds `?lang=` and `Accept-Language`
  ahead of the cookie for `/s/<token>` (see "Shared view"), and the shared tree
  never writes `NEXT_LOCALE`. Every other route keeps the cookie-only rule.
- **Backend error text is localized server-side**, not in the browser:
  `services/api.ts` sends `Accept-Language: <locale>` on every API call
  (`baseHeaders()`), and the backend returns localized `detail`/SSE messages
  (see `backend/docs/architecture.md`). `api-locale.ts` additionally carries
  the few frontend-side ApiError fallback strings (`apiFallback()`) — its
  English values are pinned by `api-error-detail.test.ts`.
- Dates: `formatDate`/`splitDateLabel` in `lib/utils.ts` take a `locale` param
  (call sites pass `useLocale()`); the connector (" at " / " в ") is shared so
  the reverse-parse in `splitDateLabel` stays in sync. Status enums render
  through `localizedStatus()` (`lib/status-labels.ts`), never raw.
- Tests: components under test need the i18n context — wrap renders with
  `TestI18nProvider` (`src/test/i18n-test-provider.tsx`, English by default,
  so all English assertions pass unchanged).
- **Still English by design**: pydantic 422 validation text, catch-all SSE
  `str(e)` errors, DB-persisted entry titles/categories, flowsheet date-column
  labels ("May 26" — server-formatted and embedded in composite ids), the
  printed document's language maps in `print-editor.tsx` (those localize the
  DOCUMENT per its target language, independent of the UI locale), and
  technical identifiers (modality values, `EN` badges). Unit strings and
  qualitative values are NOT in this list anymore — they are translated at
  display time for `ru` (see the display-time RU translation section).

## Batch import UI (background extraction jobs)

Companion to `docs/batch-import-tickets.md` (repo root) and the backend's
"Batch import" section. One user intent — "import these N documents" — has
four surfaces, all fed by ONE shared react-query cache key:

- `services/import-jobs.ts` — `createImportJob` / `fetchImportJobs` /
  `fetchImportJob` / `cancel` / `retry` / `dismiss`. Same proxy + Accept-
  Language conventions as `services/api.ts` (which now exports
  `extractDetail` for its sibling service modules). `ImportJobDetail.result`
  is the SSE result-event shape verbatim.
- **Submission on `/add-entry`** (headless, `lib/hooks/useBatchSubmit.ts` —
  ISSUES.md #76 rework, the interactive `BatchImportPanel` is GONE): dropping
  or picking ANY number of files (the `UploadScreen` picker/dropzone accept
  `multiple`) submits one background job per document from the page itself —
  capped, SEQUENTIAL `min(N, remaining)` POSTs from `fetchUsageLimits()`; a
  failed submit stops the loop (never fire-all-and-eat-429s); a failed limits
  check fails closed (no submissions). Files beyond the quota are skipped
  with a warning toast; with nothing accepted the user stays on /add-entry
  with an error toast (the file is not lost — re-drop to retry). While
  submissions are in flight the dropzone shows a transient "Submitting…
  documents" card and a plain `beforeunload` prompt fires; on success the
  page redirects to /imports (`AddEntryView.onTrackImports`: single job →
  `/imports?focus=<id>`, several → the plain list). The submitter also
  registers the accepted job ids as NEW (see the tracker below). The armed
  leave-guard+abort behavior stays exclusive to the single-file SSE
  replacement-extraction path (`useExtraction`).
- **Leave-guard is NOT armed for submissions** — nothing is lost by leaving
  (extraction continues server-side), so the guard's Back interception and
  modal would be pure friction. Only the plain `beforeunload` prompt fires
  while submissions are still in flight (uploads not yet accepted).
- **Shared poll** (`lib/hooks/useImportJobs.ts`): `['import-jobs', uid]`
  (`uid = session?.user?.id ?? 'anon'` from `useAuthPrincipal`) polled ~3s
  while mounted + refetch on window focus (iOS Safari suspends JS in
  background tabs; all catch-ups must surface on resume). /add-entry's
  post-submit invalidation surfaces fresh jobs without waiting for the next
  tick (the `['import-jobs']` prefix still matches); the tracker is the only
  mounted consumer. The query is GATED on session readiness
  (`useAuthPrincipal`: `enabled: status !== 'loading'`): mounting fires
  before next-auth resolves the bearer token, and a tokenless request would
  be answered by the ANONYMOUS principal (HTTP 200 + empty list) and cached
  until the next poll tick — the reload pop-in. The per-user key suffix also
  means a login/logout switch can never serve the previous principal's
  cached data; the tracker renders a skeleton (`imports-loading`) while
  pending, never the empty state.
- **Bell** (`notification-bell.tsx` in the header, right of the language
  switch, visible for anonymous sessions too): `['notifications', uid]`
  polled ~10s + focus refetch, gated on session readiness exactly like the
  jobs poll; badge = unread count, cleared on open (read-all; a failed
  read-all surfaces an error toast — it must not silently read as "read
  didn't stick" when the badge reappears on the next poll).
  Toasts are COALESCED via the pure `freshImportNotifications()` helper —
  >1 newly-arrived unread notifications produce ONE summary toast linking to
  `/imports`; a single one toasts individually with a review deep-link.
  Arrival detection keys off `created_at` (never the read state), and the
  first load never toasts the backlog.
- **Tracker `/imports`** (`imports-tracker.tsx`, `src/app/imports/page.tsx`):
  every caller job newest-first in TWO sections — active work
  (queued/processing/failed/done, clickable as before) and "Earlier
  imports" (saved + cancelled + dismissed rows, muted) COLLAPSED behind a
  toggle by default ("Show earlier imports (N)"); the section auto-expands
  while it holds a restorable dismissed row (Restore must stay
  discoverable), and any explicit toggle wins from then on. Saved rows are
  kept server-side as `status='saved'` history, not deleted on save.
  Every row carries a metadata line — the status's last
  transition time (`Submitted/Extracted/Failed/Saved/Cancelled {time}`,
  localized via shared `formatDate`; for saved rows that's the save time)
  plus the file size. Click behavior: done → `/review-import?job=<id>`;
  queued/processing → the extraction-process view; failed → inline error +
  Retry/Dismiss. Done rows additionally show a one-line warning when the
  backend's `merge_conflicts` summary field is non-empty ("Overlaps {count}
  existing biomarkers — merging will be blocked", full analyte list on
  hover via the title attribute) — the backend computed it at list time
  with the same rule the merge endpoint enforces, so the user doesn't enter
  the review editor in vain. The in-flight view renders the EXACT
  upload-screen
  visuals: `ExtractionProgressCard` (extracted from `UploadScreen`, which
  renders it unchanged) in snapshot mode — fixed eta from the job's
  `progress.estimate_s`, indeterminate bar, in-view cancel. A job completing
  in view auto-transitions into the review editor. Empty state links to
  `/add-entry`. The page has the standard chrome (HeaderBar + shared
  `BackNav` back-to-dashboard strip). Entry points: the bell's footer link,
  the review page's
  back nav, and the automatic redirect after /add-entry submissions.
  NEW-job badges (ISSUES.md #76 rework): ids accepted from /add-entry are
  recorded by `lib/new-import-jobs.ts` in sessionStorage (per tab);
  `imports-tracker.tsx` reads the set per render (no mirror state) and
  pills active rows not yet opened, so freshly added extractions are
  recognisable from previously viewed ones. Opening a job — the focused
  redirect or a row click into the progress view, the review editor mount
  (covers bell deep-links), or the in-view auto-transition — marks it seen
  and the pill disappears.
- **Review `/review-import?job=<id>`** (`review-import.tsx`): fetches the
  staged record (GATED on session readiness like the polls — a deep-link
  hard-reload would otherwise fetch tokenless, get the tenant-scoped 404 and
  park the page in the permanent "gone" state, since that query has
  `retry: false`) and prefills the EXISTING `AddEntry` editor machinery —
  `AddEntry` takes a `stagedJob` prop and applies the record through the
  same fill path as the SSE result (render-time derived-state adjustment,
  once per job id — unit-conflict dialog, merge checkbox and document-type
  editors all work unchanged). The staged document is fetched from
  `GET /api/import/jobs/{id}/file` and passed as a preview-only `File`
  (NEVER in the save payload). Save/merge append `import_job_id` to the
  FormData and send NO file (the backend adopts the staged file, charges
  storage and keeps the job as a saved history row). The page has the
  standard chrome (HeaderBar + shared `BackNav` back-to-imports strip);
  Save/merge, Dismiss AND "Leave for later" all return to /imports. ALL
  ready-state actions live in ONE footer: `AddEntry` gained an optional
  `footerActions` ReactNode slot (rendered on the card footer's LEFT side;
  when present it also suppresses AddEntry's default Cancel button — the
  review page's "Leave for later" makes a separate Cancel redundant; the
  Save/Merge & Save button and its `merging`/`timeRequired` internals stay
  untouched on the right). The slot carries Dismiss (immediate, no confirm —
  same semantics as the tracker's dismiss: `DELETE /api/import/jobs/{id}` →
  job kept as `dismissed`, staged file + result kept for the tracker's
  Restore within the GC TTL, bell notification deleted; still navigates away
  on failure since the job is gone or consumed either way) and "Leave for
  later" (job stays staged). The same-date strategy is the
  existing merge checkbox (merge with `import_job_id` mirrors today's
  upload-then-merge flow without a re-upload).
