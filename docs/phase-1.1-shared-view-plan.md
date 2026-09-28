# Phase 1.1 — Shared view plan: short view, full record, print, translations

**Status:** decided by the owner (2026-09-27); supersedes the earlier revision
of this document.
**Scope:** the recipient (shared) surface only. No changes to the owner's app
behaviour, to the extraction pipeline, or to the share API's security model
beyond the additions listed here.

The owner's direction, which this plan implements:

> When someone opens a shared link they see a simplified view with an easily
> reachable toggle to switch to the full version. The full version is
> marginally distinguishable from the general user's view — it's just that you
> view someone else's data, so you cannot modify it; but you can enter, for
> example, the correlation graph, change the language, or do something else.
> Translations take the viewer's own limits (for logged-out users, only a
> limited amount of translation). Print means the feature the user's own view
> already has — the printed passport — not the browser's print of the page.

---

## 1. The decision

One route, two views of the same record, chosen by the recipient and carried in
the URL:

- **Summary** (`?view=summary`, the default) — the short read: what is out of
  range, what changed, then the history. It answers the clinical question in
  the first 30 seconds.
- **Full record** (`?view=full`) — the record the way its owner sees it: the
  app's own information architecture and components, over someone else's data,
  with every write affordance removed. Timeline, flowsheet, correlation,
  language, and the printed passport.

The toggle is a two-item segmented control at the top of the page, inside the
first viewport on both breakpoints. It is a plain link pair (works without
JavaScript) and switches in place when JavaScript is available, since the
payload is already loaded. The state is the URL — never a cookie, never
`localStorage`.

Two things this deliberately is not: **not a modal on arrival** (a stranger
cannot answer "which view?" before seeing anything, and asking costs the
highest-value 30 seconds on the page), and **not a sender-side setting** (two
links recreate the version confusion the feature exists to remove).

---

## 2. What each view contains

**Summary** — the current sections, corrected and denser on desktop:
orientation strip, count line, flagged readings as a row grid at `≥md` (cards
below), trends, visits/imaging/procedures, disclaimer, CTA.

**Full record** — the app's own views, read-only:

- the **timeline**: entry list with type chips, counts and search, beside the
  selected entry's detail (results table, visit detail, instrumental detail);
- the **flowsheet**: the wide matrix, its filters and date ranges;
- the **correlation** view, with its existing exploratory framing;
- the **language** switch and the **print** flow (the passport, §4);
- no documents tab (attachments are still not shared), no entry settings, no
  upload, no add entry, no notifications, no write affordance of any kind.

---

## 3. Read-only, structurally

- **Viewer capability** replaces `useDemoMode`'s boolean: `owner` | `demo` |
  `shared`. `entry-settings` (delete, copy id) renders nothing for a non-owner,
  and any future stateful component asks the capability rather than the demo
  flag. This is the moment §9.2 of the technical plan anticipated.
- **No write path is reachable**, not merely hidden: the public router stays
  GET-only for reads, and the authed imports (`services/api.ts`,
  `lib/auth-token`, `AuthProvider`, `QueryProvider`, `i18n/api-locale`) stay
  banned from the shared tree. The import-graph test is the guard and must keep
  passing.
- The recipient still gets **no session, no cookie, and no identity**.

---

## 4. Print — the passport feature, share-scoped

What the owner calls "printing" is the app's own print flow (`/print-setup` →
`/print-editor`): translation mode and target language, then layout, text size,
column and biomarker filters, ending in the browser's print of the generated
document. The full record exposes that flow to the recipient so a doctor can
produce a proper multi-language sheet to show colleagues.

- The **print editor** is client-side over the flowsheet payload, so it is
  reachable with a share-scoped payload — no new data path.
- The **translation step** is LLM-backed and therefore the only part of this
  plan that costs money per use: §5 bounds it.
- **`persist` must be false for recipients.** A stranger's translation run must
  never write into the owner's shared `names[lang]`, and must never consume the
  owner's AI quota — it gets its own bucket.
- The plain `window.print()` of the record page stays possible (it is a browser
  capability) but it is not the feature, and nothing here depends on it.

**The printed sheet is a document, and paper escapes revocation.** The printed
passport carries the record's identity per the header toggle, the printed date,
`shared via HealthPassport`, the not-a-diagnosis line, and the link's expiry
where known. Because a printed sheet cannot be recalled, the sender's dialog
copy must say that a recipient can print the record, in the same sentence as
the expiry.

**As shipped (ST4):** the flow is entered from a Print button in the shared
chrome, present in BOTH views and at both breakpoints, and its two steps are
`?print=setup` / `?print=editor` on the record's own route — URL state, like the
view toggle, so Back steps out of the flow and a reload or a shared URL lands on
the same STEP. Only the step is in the URL: the print CONFIGURATION (mode,
target language, layout, text size, column and biomarker selections) lives in
`PrintConfigProvider` state and resets, so a bookmarked editor URL renders the
document with the default configuration — recorded as a follow-up, not fixed
here. The provenance block renders inside the printed document, in the
document's own language, rather than as screen chrome; the owner's own passport
passes no provenance and its output is unchanged.

---

## 5. Recipients and AI cost — the translation limit

Today a share link is a **third principal class with no `UsageLimit`**
(`AGENTS.md`). Giving recipients an LLM-backed feature introduces cost and an
abuse surface on a public page, so the limit is explicit and server-side:

- **A per-link translation budget** (start at 3 runs), stored against the link,
  with the remaining count shown to the recipient before they spend one.
- **A bounded payload per run**: only the biomarkers present in the shared
  record, never the whole dictionary — the mistake the Stage 3 review caught in
  the sender-side dialog.
- **The existing per-IP public throttle** for bursts, unchanged.
- **Its own quota bucket.** A recipient's run must not decrement the owner's AI
  allowance, and cannot be charged to an anonymous user — a recipient has no
  session to charge.

"The viewer's own limits" is therefore implemented as *the link's* limits,
because a recipient has no identity by design: a stranger gets a small,
visible, bounded allowance, and the link's owner sets how much of their record
a stranger may have translated.

**As shipped (ST4):** the budget is `share_links.translate_runs_used` with
`SHARE_TRANSLATION_BUDGET = 3`, reserved by one conditional UPDATE and refunded
when the model produced nothing. The bounded payload is enforced one step
earlier than written above — the request body is `{lang}` and the server
derives the names and headings from the link's own record — so there is no
client-supplied list to bound. "Its own quota bucket" is the link's counter:
no `UsageLimit` row is read or written on the path at all. Exhaustion is a
localized 429, and the reader sees it on the setup screen rather than getting
an untranslated document.

---

## 6. Correlation

The full record includes the correlation view, computed from the same scope.
This reverses an earlier decision to keep correlation off the recipient
surface, so the reasons are recorded with it:

- It is a **claim risk**: the view suggests pairs at n ≥ 4 and |r| ≥ 0.5, which
  on a clinician's screen reads as an assertion. It keeps the app's existing
  exploratory framing, and the page keeps the not-a-diagnosis line.
- It must **not** appear in the summary — the summary stays the clinical read.
- It pulls **recharts** into the recipient's bundle, so it must be
  **lazy-loaded**; a bundle check is part of the acceptance criteria, not an
  aspiration.

**Corrected in ST3: there is no share-scoped correlation endpoint, and there
should not be one.** This section originally called for
`GET /api/share/correlation` "computed server-side". The owner's correlation
is not a server computation at all — `views/CorrelationView.tsx` renders
`CorrelationChart` over the biomarkers in the `/api/timeline` payload, and
`lib/stats.ts` does the arithmetic in the browser. The share record already
carries the same `biomarkers` array, already narrowed to the link's date range
and exclusions by the same five builders. A server-side twin would therefore
be a *second implementation of the same numbers*, which is exactly the drift
the "same numbers as the owner's view" criterion exists to prevent. The
recipient's section renders the owner's own component over the owner's own
payload shape, so equality is structural rather than maintained by hand.

---

## 7. Subtasks

Each subtask is implemented by one agent, reviewed by a second, and fixed by
the first when the review blocks. A final review then covers the whole change
in a browser with screenshots.

### ST1 — Short view: defects and density

Status as a word or pill, never colour alone (a written promise, and WCAG
1.4.1); the `см.комм.`-class value kept out of the flags (needs a one-line
amendment to D13, which today covers only `needs_review`); locale-formatted
DOB; trend chains capped at three dated points; a count line above the flags;
full numbers on the printable surface; the flags block as a row grid at `≥md`.

Done when: every flagged row carries visible status text and an `aria-label`;
a backend test proves an unrecognised qualitative value never enters the flags;
a biomarker with 8 readings renders exactly 3 dated points; the flags block
drops from ~1,500px to ~1,250px at desktop width with ~60px rows; all existing
suites green.

**Target corrected after implementation**: the original "~500px" was
unreachable. At ~28px per row the block would be denser than the app's own
flowsheet (54.5px), and the only way there is to drop the original printed name
or the measurement date, both of which a doctor needs. The review confirmed the
deviation and the number above is the accepted one. The remaining scan cost on
a wide screen is a shell problem, not a row problem — it is ST2's job.

### ST2 — Full record v1: the read-only app surface

The viewer capability (`owner`/`demo`/`shared`); the `lg` desktop shell with a
`print:hidden` rail; the top **Summary | Full record** toggle with `?view=`
(plain links, in-place switching with JS); the full view rendering
`TimelineContent` fed by the share payload plus the share-scoped flowsheet;
the language switch and orientation header inside the shell.

Done when: both views are reachable, bookmarkable and printable; switching is
instant with JS and functional without it; the full view shows the record with
no write affordance; the import-graph test passes with `TimelineContent` in the
shared tree and no recharts in the summary's bundle; no horizontal overflow at
1024/1280/1440/1920.

**Shipped (ST2).** All of the above holds, with three notes where reality
differs from the plan:

- **"No recharts in the summary's bundle" is met literally, not just at first
  paint.** The shared page's initial script list dropped from 1,058 KB across
  12 chunks to 797 KB across 14, the 342 KB recharts chunk is in neither view's
  server-rendered HTML, and a live run of both views reports zero
  `[class*="recharts"]` nodes — nothing is fetched, lazily or otherwise. Two
  gaps had to close for that: the matrix's sparkline column
  (`FlowsheetMatrix` gained `showTrend`, which `SharedFlowsheet` sets false;
  the whole column goes, not just its contents) and the expanded reading row's
  trend chart. `lib/chart-series.tsx` also gave up its one runtime recharts
  import (`Curve`) to `lib/chart-line-shape.tsx` — the matrix imports that
  module for `coerceChartValue`, so the import was putting recharts in the
  first paint of every page with a matrix, including `/demo`.
- **Two extra lazy boundaries were needed, which the plan did not foresee.**
  The full record renders the owner's components, so `services/api` arrived via
  `entry-settings` (now `entry-delete`, dynamically imported) and
  `lib/auth-token` arrived via `lib/utils` (the bearer-token document helpers
  moved to `lib/authed-documents`, imported inside `document-tab`'s handlers).
  The import-graph test now walks the real graph and pins those edges by name.
- **The chrome is one markup tree, not a rail plus a mobile header.** The rail
  and the phone strip are the same elements; the container is `display:
  contents` below `lg`. Rendering both and hiding one with CSS would leave two
  language switches and two toggles in the DOM — invisible to the eye, not to a
  screen reader or a test.

Four things ST2's review changed after the fact, recorded here because each one
corrects a claim this document or the architecture doc had made:

- **The toggle was not request-free.** Each view owned its own flowsheet fetch,
  so every Summary ↔ Full record switch re-requested ~1.3 MB — 4 requests for a
  load plus 3 toggles. The fetch is now owned by the shell
  (`useSharedFlowsheet`, called from `SharedRecordView`) and handed down:
  measured 1 request for the same sequence, and pinned by a test that fails if
  the count moves on a switch.
- **The rail does cost the results table its Status column between `lg` and
  ~1400px**, and the architecture doc's earlier "that is the app's own
  narrow-pane behaviour, not the rail" clause was wrong: `/demo` renders the
  same table with 0px of overflow at 1280, against 133px here. `ResultsPanel`
  now takes a capability-aware `minTableWidth` (768px owner, 620px recipient),
  which fits the table — Status included — at 1280 and leaves 1440+ untouched.
  At 1024 the pane is only ~394px, which no six-column lab table fits; that
  band still scrolls, and the fix there is only that it hides 226px instead of
  374px.
- **The shared matrix loses its sparkline column**, so it is visibly a column
  narrower than the owner's flowsheet — a deliberate trade for the 350 KB.
- **The flip side of the reuse** — a missing message key reaches a stranger as
  a raw key — is now guarded by a test that fails on next-intl's
  `MISSING_MESSAGE` warning (it caught exactly that during ST2's live check).

### ST3 — Correlation and language in the full record

`GET /api/share/correlation` (public, resolver-scoped, `no-store`, same uniform
404 posture as the other public reads); the recipient correlation view with its
exploratory framing, lazy-loaded behind the full view; the language switch
reaching the full view's strings; the recipient catalog widened only as far as
the components actually call.

Done when: correlation renders the same numbers as the owner's view for the
same record and scope; it is absent from the summary; recharts is not in the
summary's first-paint bundle; the framing and disclaimer are present; the
suites are green.

**Shipped (ST3).** All of the above holds, with the endpoint replaced as §6
now explains, and four details worth recording:

- **The chart arrives on a CLICK, not on mount.** `next/dynamic` still imports
  its target when it mounts, so a section that rendered the dynamic chart
  unconditionally would fetch recharts on the full record's first paint. The
  section renders a **Show correlation chart** button and mounts the chart only
  after it is pressed. Measured on a production build with network capture: 14
  chunks and **zero** recharts requests before the click, 17 chunks and one
  recharts request after, at both 1280 and 1024.
- **`SharedCorrelation` restates `hasReadings` rather than importing it.**
  `correlation-chart.tsx` exports that predicate, but importing it would pull
  the chart — and recharts — into the shared tree's *eager* graph. The
  duplication is deliberate and pinned by the import-graph test, which now
  lists `correlation-chart.tsx -> recharts` as a lazy edge.
- **The correlation input is narrower than the owner's, by exactly the merged
  readings.** Measured against the live dev record: the owner's payload has 160
  biomarkers, the share payload 131, and the 29 extras are merged-only
  readings (D15). After dropping merged readings from the owner's side, the two
  sets are identical point for point, and both surfaces produce the same 346
  pairs with the same `n` and `r` (the owner's own payload has 754). Of the
  pairs the panel actually lists — the *suggested* ones, n ≥ 4 and |r| ≥ 0.5 —
  the owner has 161 where the reduced sets have 122; 79 suggestions are gone
  and 40 new ones appear, and **none of those 119 involves a merged-only
  biomarker**. They are pairs of biomarkers present on both sides whose
  relationship changes because merged readings leave the series.
- **Sibling fix from the ST2 review.** The expanded reading row now keeps its
  heading and reference line for a recipient and drops only the chart
  (`expanded-biomarker-details.tsx`): dropping all three left the metric cards
  below unlabelled, and the reading-history chips already carry the numbers the
  chart would draw.
- **The confidence verdict does not travel (ST3 review, F3).** §6's rule was
  "if it cannot be made unambiguous, correlation stays out"; the ruling keeps
  the chart and removes the claim. For a `shared` viewer the panel and the pair
  label replace `likely a real relationship` with
  `exploratory: {count} shared readings` — the sample size named in the phrase
  itself — and the legend drops the sentence explaining the 5% threshold,
  because that sentence exists only to explain the phrase. The panel ranks
  pairs by |r|, so the threshold is never corrected for that selection effect,
  and a significance verdict on seven points in front of a clinician is exactly
  the assertion §6 was guarding against. The owner's view is unchanged.

### ST4 — The print passport and the translation limit

The recipient print flow (setup → editor) over the share payload; the per-link
translation budget with its own quota bucket and its visible remaining count;
`persist: false`; the printed document's provenance block; the sender-side copy
stating that a recipient can print.

Done when: a recipient can generate a document in each target language without
writing to the owner's dictionary or consuming the owner's quota; the budget
blocks the next run with a localized message; the printed document carries
provenance; a backend test proves the owner's `UsageLimit` is untouched.

**Shipped (ST4).** All of the above holds, with five details where reality
differs from this plan:

- **The payload is derived by the SERVER, not bounded by validating the
  client's.** §5 asked for "only the biomarkers present in the shared record".
  The route goes further: the body is `{lang}` and nothing else, and
  `_share_translate_targets` rebuilds the link's own flowsheet to decide what
  to translate. A public caller therefore cannot widen the batch even
  accidentally, and the "171 referenced, not the 1500-entry dictionary" bound
  holds by construction rather than by comparison.
- **"Its own quota bucket" is the LINK's counter, not a second `UsageLimit`
  row.** `share_links.translate_runs_used` + `SHARE_TRANSLATION_BUDGET = 3`,
  reserved by one conditional UPDATE and refunded when the model produced
  nothing. No `UsageLimit` row is read or written on this path at all, which
  is the strongest form of "not the owner's allowance".
- **The failure message is the setup screen's, not only the API's.** A 429
  carries a localized `share.translation_limit_reached`, and the client turns
  it into a typed error so the reader stays on the setup screen and reads
  "No AI translations left for this document. Ask the person who shared it for
  a new link." Navigating to an untranslated document would have looked like a
  translation bug.
- **`persist: false` was not enough on its own — the recipient must not COMMIT
  either.** The review dialog's confirm step persists through
  `/translate-biomarkers/commit` for an owner; a recipient's `commit` applies
  the accepted terms to the document in memory and reports `saved: 0`, which
  is also what suppresses the "saved for future documents" toast.
- **The print flow needed one fix found live, in a production build.** The
  owner's `PrintEditorView` selects every column and biomarker after its
  fetch; the shared container did not, so the recipient's document opened
  reading "Select at least one date column" over an empty table. Measured
  after the fix: 3,584 populated cells, no empty-table message, 14 chunks
  before the Print click and one more after it.

---

## 8. Doc sync

- `AGENTS.md` — the share bullet: the public surface now has a **bounded AI
  budget** per link, `persist:false` for recipients, the full-view endpoints,
  and the viewer capability; the frontend invariant: two views in one route,
  the `?view=` contract, lazy-loaded correlation.
- `frontend/docs/architecture.md` — the two views, the toggle, the capability,
  the catalog scope, the lazy boundaries, the correlation section (ST3).
- `backend/docs/architecture.md` — the translation budget and its bucket. **No
  ST3 change**: the correlation replacement in §6 removes the only backend item
  this plan had for that file.
- `docs/phase-1.1-product-plan.md` — §4.1 (the second view), §4.4 (the desktop
  shell), D13 (the uninterpretable-value rule), and the correlation reversal.
- `docs/phase-1.1-stage-3-plan.md` — S12's print sentence, which this
  supersedes.

---

## 9. Risks

- **LLM cost and abuse on a public surface.** The per-link budget is the whole
  defence; if it is bypassable, the feature is an open wallet. It must be
  enforced server-side on the existing throttle path, not in the UI.
- **Correlation reads as a claim.** The framing is the mitigation; if it cannot
  be made unambiguous, correlation stays out.
- **Two views drifting into two products.** One payload, one component set,
  reuse by props; the moment the full view forks a component, drift starts.
- **Bundle weight.** Correlation and the print editor pull recharts and a large
  surface into a page a stranger opens on a phone. Lazy boundaries are part of
  done, not an optimisation.
- **The read-only guarantee must stay structural.** No write endpoints, no
  authed imports; hidden buttons are not a security property.
