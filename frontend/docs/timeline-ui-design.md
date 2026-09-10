# Timeline UI/UX review and redesign

**Status:** Revision 2 — critical review completed; all comments addressed (§10)
**Reviewer:** `opencode-go/hy3` (max variant), read-only plan agent, 2026-09-10.
Note: `opencode-go/omen-alpha` (originally requested) is stale in the global
agent configs and returns a server error; the owner approved hy3 as the
substitute.
**Date:** 2026-09-10
**Scope:** the Timeline & Vitals view (`/`) of the HealthPassport frontend:
`TimelineView`, `HistoryList`, the detail views (mainly `BloodTestDetails`),
`ResultsPanel`, page chrome (`HeaderBar`, `NavBar`), and the shared tokens in
`globals.css`.
**Non-goals:** backend/API changes, print editor, flowsheet/correlation views,
rebrand, and features beyond the history-card status summary.

**Method and limitations.** Findings come from static analysis of the
components plus a 1920x916 screenshot of live data. No browser automation was
available during analysis, so scroll "feel" is derived from CSS layout
reasoning; items marked *(verify in browser)* must be confirmed during
implementation. The dev servers were confirmed running (`:3000`, `:8000`).

**Decisions already taken with the owner**

| # | Decision |
|---|----------|
| D1 | Desktop uses a two-pane app shell: history and details scroll independently, chrome stays pinned. |
| D2 | History cards become compact and gain a per-entry flagged-results summary (semantic status colors). |
| D3 | Below `lg`, master-detail with a sticky event switcher (no more details below an unbounded list). |
| D4 | Staged delivery: Stage 1a = pure shell, Stage 1b = alignment + tabs, Stage 2 = history cards, Stage 3 = table + mobile. |

---

## 1. Current architecture at a glance

```
TimelineView                         (min-h-screen, WINDOW scroll)
├── HeaderBar                        (not sticky)
├── NavBar                           (not sticky)
└── TimelineContent / main           (grid; lg: minmax(260px,26%) | 1fr)
    ├── aside  → HistoryList         (header / filter popover / chips / rail cards)
    └── section → BloodTestDetails   (type chip + 3 tabs)
                  └── ResultsPanel   (card header title+search / 7-col grid table)
```

Key facts:

- `TimelineContent` is intentionally shared with `/demo`
  (`demo-view.tsx` wraps it in its own `min-h-screen` page — no app shell).
- Selection state lives in `TimelineContent`; default is the newest event
  (`TimelineView.tsx:59-61`). `biomarkersAtDate` derives per-event values.
- `HistoryList` owns filter/sort/search state and sorts newest-first by
  default (`history-list.tsx:33`).
- `BloodTestDetails` owns the inner tab state, default `results`
  (`blood-test-details.tsx:50`).
- All data is client-side; no new fetches are needed for the planned work.

---

## 2. Findings

### F1 — Desktop is one document scroll; nothing is pinned

Evidence:

- Root `min-h-screen` (`TimelineView.tsx:22`), `main` with no height
  constraint (`TimelineView.tsx:98`).
- `HeaderBar` and `NavBar` have no sticky/positioning (`header-bar.tsx:76`,
  `NavBar.tsx:29`).
- No `sticky` anywhere in the timeline path (only flowsheet/print use it).

Impact: patient identity, section navigation, the History toolbar/filter, the
results title/search, and the table's column headers all leave view when
reading down a long biomarker table. Switching to another event requires
scrolling back to the top.

### F2 — The details pane's `overflow-y-auto` is inert (latent scroll trap)

`BloodTestDetails` is `flex h-full w-full flex-col`
(`blood-test-details.tsx:78`) and the results tab is
`mt-5 flex-1 overflow-y-auto` (`:128`). The `overflow-y-auto` never engages:

- the parent `section` is a grid item in an `auto`-sized row, so its height
  depends on content and is indefinite for percentage resolution;
- `h-full` on the child therefore computes to `auto` — the region is
  content-sized and grows with the table, so the **window** scrolls.

Correction from review: an earlier draft claimed `h-full` resolved to the
stretched row height; the row is indefinite here, so percentage resolution
yields `auto`. The conclusion and the fix are unchanged: the pane needs an
explicit definite height (shell) plus a `min-h-0` chain before any inner
`overflow` can be trusted; until then this wiring is a latent nested-scroll
trap that changes behavior silently when heights change *(verify in
browser)*.

### F3 — Reading results loses all context

No sticky element exists across: page chrome, the tab strip, the results card
header (title + search), or the table column header. Search and sort are
unreachable while scanning a long table; column labels vanish as soon as the
header scrolls away.

### F4 — Below `lg` the details pane is buried

The only layout breakpoint is `lg:grid-cols-[...]`
(`TimelineView.tsx:98`). Under 1024px the two columns stack, so reaching
results requires scrolling past all history cards (22 in the seed data).

### F5 — Columns do not share an inset

- History cards start at aside + rail padding (`pl-5 sm:pl-7`,
  `history-list.tsx:462`); the "History" heading uses `px-1` (`:179`).
- Details pane adds `px-6` on its root (`blood-test-details.tsx:78`).
- Net: the two panels' content edges differ by ~4-28px depending on
  breakpoint; nothing lines up (see screenshot: History heading, chip row and
  cards vs. tab strip and results card).

### F6 — First-content rows do not align; the rail misses the detail top

- Left header zone = title row (28px) + `gap-3` + chips row (~22px) + `gap-3`
  ~= 74px to the first card.
- Right header zone = tab strip (~28px) + `mt-5` (20px) = ~48px to the card.
- The screenshot shows the results card starting ~30px above the first
  history card, so the rail's first node hangs below the details top — the
  exact misalignment that commit `2744608` claimed to fix.

### F7 — Inner tab strip is a different UI idiom than the main nav

`blood-test-details.tsx:79-116`: plain text buttons separated by literal `|`
characters (`text-muted-foreground/20`), active state = font weight only;
`flex-wrap` can orphan a separator at a line end. The main `NavBar` uses
underline tabs with a primary indicator (`NavBar.tsx:38-45`). The tab strip
also duplicates the card title ("Test Results" tab + "Blood Test Results"
heading).

### F8 — History cards are sparse and under-informative

- ~84-100px per card (`p-3`, `size-9` bubble, `line-clamp-2` title,
  `history-list.tsx:492-519`) for three short lines; ~9-10 visible at 900px.
- Date sits below the title, so the chronology axis is not scannable; date
  granularity varies ("Jun 25, 2026 at 16:17" vs "Jun 19, 2026").
- The attachment count floats vertically centered at the far right
  (`ml-auto`, `:517`), detached from the metadata.
- No per-entry status hint: finding the abnormal labs among 19 entries needs
  the hidden "Abnormal results" filter (popover, `:316`) or opening each card.

### F9 — Results table polish gaps

- Numeric columns (Latest, Unit, Reference) are left-aligned in fractional
  tracks (`GRID_COLS`, `results-panel.tsx:29`), no `tabular-nums`.
- Sort affordance is hover-only (`opacity-0 group-hover:opacity-100`),
  invisible on touch.
- No sticky column header (F3).
- Title/subtitle duplicated with the tab strip (F7); search input width bug
  below `sm` (see F10).

### F10 — Resolution behavior is uneven

- `1024-1150px`: right pane ~656px < table `min-w-[768px]`
  (`results-panel.tsx:247`) -> horizontal scroll already at the layout
  breakpoint; the 260px sidebar wraps titles heavily.
- `>1800px`: layout caps at 1800 but the 7 fractional columns stretch to
  ~1280px, leaving large whitespace.
- `<640px`: search wrapper is `shrink-0` with width only at `sm:w-64`
  (`results-panel.tsx:235`) while `Input` is `w-full`
  (`ui/input.tsx`) -> percentage against auto width, fragile intrinsic sizing.
- Breakpoint inventory in the timeline path: `sm:` (node/rail sizes, row
  padding, `sm:w-64`, header user name) and one `lg:` layout rule. No `md:`,
  `xl:` or `2xl:` rules.

### F11 — Chrome and states (minor)

- Sticky chrome will need an explicit z-scale; currently only local z-values
  exist (popover `z-50`, user menu `z-20`, notifications).
- Loading/error states are bare centered text (`TimelineView.tsx:83,91`).
- `html { overflow-y: scroll }` (`globals.css:259`) will keep an empty
  scrollbar gutter in an `h-screen` shell on platforms with classic
  scrollbars — acceptable, but worth knowing.

---

## 3. Constraints and invariants (must not change)

1. **Type vs status color channel contract** — type colors (`--event-*`) paint
   only icon bubbles, rail nodes, chips and dots; status colors stay semantic;
   the primary accent is interaction only. New status chips in cards must use
   `--status-*` tokens. No mixing. (`frontend/docs/architecture.md` "Event-type
   visual language".)
2. **Merged-readings semantics** — `biomarkersAtDate` `isLatest`-gated flags,
   merged groups only in the details timeline; do not alter.
3. **i18n** — next-intl, cookie-driven, EN/RU parity test; EN values are
   pinned by ~280 existing assertions; add new keys, never reword existing.
4. **Proxy** — all API calls stay behind `next.config.mjs` rewrites.
5. **Demo surface** — `TimelineContent` is shared with `/demo`; the fixture
   has no API and the page has its own header. Any shell must not break it.
6. **Print** — timeline is not a print surface; `print:hidden` chrome is
   already in place; no `event-*` tokens in print.
7. **Tests** — `history-list.test.tsx` (37 assertions) and
   `results-panel.test.tsx` (43) pin markup/text; structural changes must
   update them deliberately. `blood-test-details.test.tsx` also exists.

---

## 4. Options considered

| Topic | Options | Chosen | Why |
|---|---|---|---|
| Desktop scroll | (a) one page scroll + sticky bars; (b) two-pane shell; (c) minimal fixes | **b** | Long tables + long history both need stable context; matches flowsheet precedent of internal scroll. |
| Pinning mechanism | (a) `sticky` within one scroller; (b) self-contained panes with internal scrollers | **b** | Avoids magic sticky offsets (`top-[64px]`) that break when headers wrap or locale changes. |
| Desktop scroll (alt.) | window scroll + per-pane `position: sticky; top: var(--chrome-h); max-height: calc(100vh - var(--chrome-h)); overflow: auto` | rejected for now | Same context retention without `h-screen`/`overflow-hidden` (no print clipping, less scroll-trapping), but needs `--chrome-h` measurement on desktop from day one and `align-self: start` sticky-in-grid handling; kept as the fallback in §5.1 if R2 materializes. |
| Card density | (a) compact + summary; (b) compact only; (c) polish only | **c + summary** | 19 entries need at-a-glance anomaly discovery; compacting (a/b) was rejected on looks at T3, so only the summary chips ship (T4). |
| `<lg` | (a) master-detail + switcher; (b) capped history; (c) defer | **a** | Details must be reachable in one gesture. |
| Delivery | (a) staged; (b) one change; (c) pick items | **a** | Isolate the risky shell restructure; review it before density work. |

---

## 5. Design

### 5.1 Desktop shell (Stage 1a)

The height model spans **two** components — an earlier draft wrongly
attributed the whole shell to `TimelineView` (review comment 1):

- `TimelineView.tsx:22-25` owns the page root and the chrome (`HeaderBar`,
  `NavBar`) — the root flex column and sticky chrome wrapper go here.
- `TimelineContent` (`TimelineView.tsx:97-111`) owns `main`/`aside`/`section`
  — the per-pane constraints go here.

```tsx
// TimelineView.tsx — root + chrome
<div className="flex min-h-screen flex-col bg-background lg:h-screen lg:min-h-0 lg:overflow-hidden print:block print:h-auto print:min-h-0 print:overflow-visible">
  <div className="sticky top-0 z-40 lg:static print:static">
    <HeaderBar />
    <NavBar activeTab="timeline" />
  </div>
  <TimelineContent ... />
</div>

// TimelineContent — panes (the same markup also renders on /demo)
<main className="mx-auto grid w-full max-w-[1800px] flex-1 gap-5 p-5 lg:min-h-0 lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden lg:grid-cols-[minmax(288px,26%)_1fr] print:block print:h-auto print:overflow-visible">
  <aside className="min-w-0 lg:min-h-0 print:h-auto">
    <HistoryList ... />
  </aside>
  <section className="min-w-0 lg:min-h-0 lg:overflow-hidden print:h-auto print:overflow-visible">
    {/* detail views */}
  </section>
</main>
```

- **The aside does not clip** (T1 review comment 2): `lg:overflow-hidden` was
  dropped from the aside — the rail scroller clips its own content, and the
  filter popover must be able to overhang the column into the grid gutter.
  The popover additionally self-caps:
  `max-h-[min(32rem,calc(100dvh-7rem))] overflow-y-auto overscroll-contain`.
  `main` keeps `lg:overflow-hidden` (the popover never leaves it).
- **Explicit pane row** (T1 review comment 8):
  `lg:grid-rows-[minmax(0,1fr)]` documents the stretched implicit row instead
  of relying on default `align-content` behavior.

- **`/demo` degradation guarantee** (not "untouched"): `TimelineContent` is
  shared (`demo-view.tsx:79`) inside a `min-h-screen` *block* root, so
  `flex-1`, `min-h-0` and `overflow-hidden` are inert there (no flex parent,
  no definite height) and the page keeps its document scroll. This is a
  guarantee to verify in §8; escape hatch if it proves fragile: a
  `layout?: 'shell' | 'page'` prop on `TimelineContent` (default `'page'`).
- **Print safety** (review comment 2): `lg:` is a min-width query and also
  matches print layouts at >=1024 CSS px (A4 landscape ~1123px), so a direct
  Ctrl+P of the timeline could clip the panes. Every height/overflow utility
  in the chain is paired with `print:h-auto print:overflow-visible
  print:static`; verify print preview in §8.
- **Sticky chrome below `lg`**: `sticky top-0 z-40`; `lg:static` because the
  shell itself no longer scrolls at `lg`. Wrap-safe without offset math.
- **Pane height**: `main` is `flex-1 min-h-0`; each pane is a stretched grid
  item with `min-h-0 overflow-hidden`; each pane's component provides its own
  scroller (5.2/5.3). This gives `h-full` a definite parent — the F2 remedy.
- **Z-scale** (single documented scale): pane content 0, sticky table header
  10, pane headers 20, chrome wrapper 40, popovers 50, dialogs 70+.
- **Fallback**: if percentage height proves unreliable in a browser
  *(verify in browser)*, replace `lg:h-screen` on the root with
  `lg:h-[calc(100vh-var(--chrome-h))]` and set `--chrome-h` from a
  ResizeObserver — the same measurement needed for the mobile switcher (5.7).
- **Alternative rejected for now**: sticky panes with
  `max-height: calc(100vh - var(--chrome-h))` under window scroll (§4). Same
  context retention without `h-screen`, but it would require the `--chrome-h`
  measurement on desktop from day one and `align-self: start` sticky-in-grid
  handling. Keep it as the fallback if R2 (nested-scroll trapping)
  materializes in user feedback.

### 5.2 Left pane — `HistoryList` becomes self-contained

```tsx
<div className="flex h-full min-h-0 flex-col gap-3">
  <div className="shrink-0 flex items-center justify-between px-1">History + filter</div>
  <div className="relative shrink-0">chips (unchanged)</div>
  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1">
    <div className="flex flex-col gap-2">rail rows</div>
  </div>
</div>
```

- The header/popover stay outside the scroller, so the popover is never
  clipped by it. The popover keeps its own scrollbar — it is the one overlay
  exception, since the bar is its only scroll affordance.
- Below `lg` (and on `/demo`), `h-full` resolves to auto and `flex-1` grows
  with content: the component degrades to the current page-scroll behavior
  with no extra markup.
- The scroller gets `role="region"` labelled via `aria-labelledby` pointing at
  the "History" `<h2>` (T1 review comment 7 — no duplicated `aria-label`) and
  `tabIndex={0}` so keyboard users can scroll it directly. `px-1`/`pb-1`
  breathing room keeps the selected node's ring and card focus outlines from
  being clipped by the scroller's overflow (T1 review comment 3).
- The rail scroller and the chips row use the shared `scrollbar-none`
  utility (see §5.8): no visible scrollbar on any platform.

### 5.3 Right pane — `BloodTestDetails` owns per-tab scroll

```tsx
<div className="flex h-full w-full min-h-0 flex-col bg-background pb-6">
  <div className="shrink-0">type chip + tab strip (5.8)</div>
  {tab === 'results' && (
    <div className="mt-3 flex min-h-0 flex-1 flex-col"><ResultsPanel /></div>
  )}
  {tab === 'document' && (
    <div className="mt-3 flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">attachment rows</div>
      <div className="min-h-0 flex-1 overflow-hidden">DocumentViewer</div>
    </div>
  )}
  {tab === 'settings' && (
    <div className="mt-3 min-h-0 flex-1 overflow-y-auto"><EntrySettings /></div>
  )}
</div>
```

- The `px-6` root inset is dropped (F5); `main`'s `p-5` + grid gap provide the
  gutter, so both column edges align.
- Non-blood-test details (`DoctorVisitDetails`, `InstrumentalTestDetails`,
  procedure stub) are shorter-lived; Stage 1 wraps each in the same
  `flex h-full min-h-0 flex-col` + `overflow-y-auto` body so every detail type
  scrolls identically. Every per-tab scroller (results table region, document
  attachment list/viewer, settings, and the visit/instrumental equivalents)
  uses the shared `scrollbar-none` utility; the results table region keeps
  `overflow-auto` for horizontal scrolling.
- **Document-viewer deviation** (T1 review comment 6): the viewer wrapper is
  `overflow-y-auto` rather than the sketch's `overflow-hidden`, because
  `DocumentViewer` still sizes itself intrinsically (image branch `h-[80vh]`,
  PDF area `fitHeight + 32`). The attachment list above it is capped at
  `max-h-72` with its own scroll. Follow-up (tracked in the tickets doc, T5):
  give the viewer root `h-full min-h-0` and its scroll area `flex-1 min-h-0`,
  drop the intrinsic heights, then restore the wrapper's `overflow-hidden`.

### 5.4 Results panel — fixed card header + sticky column header

```tsx
<Card className="flex h-full min-h-0 flex-col overflow-hidden border-border">
  <div className="shrink-0 flex items-center gap-3 border-b p-4">
    {/* existing title/subtitle + search — markup unchanged in Stage 1a */}
  </div>
  <div className="min-h-0 flex-1 overflow-auto">
    <div className="min-w-[768px]">
      <div className={cn(GRID_COLS, 'sticky top-0 z-10 border-b bg-card px-4 py-2.5 ...')}>
```

- `bg-card` must be **opaque** (today's header row is transparent; rows would
  show through while scrolling).
- Horizontal scrolling moves the sticky header with the columns (correct
  behavior); the wrapper's `min-w-[768px]` keeps borders spanning the scroll
  width, mirroring the flowsheet fix.
- Below `lg`/on `/demo` the card is auto-height and all of this is inert.
- Optional Stage 3: freeze the Biomarker column with `sticky left-0` +
  opaque background (flowsheet precedent) so names stay visible during
  horizontal scroll at ~1024px. Z-order: header+frozen cell 30, header 20,
  frozen cells 10.

### 5.5 Alignment spec (Stage 1b)

Target: both panes share a header zone of **28 + 12 + 22 + 12 = 74px** from
the pane top to the first content row.

- Left: title row (`min-h-7`, already 28px with the filter button) / chips
  (`min-h-[22px]`, exists) / 12px gaps. Change the "History" heading from
  `px-1` (`history-list.tsx:179`) to `px-0` so the panes are truly flush to
  the grid gutter (review comment 6 — residual 4px).
- Right: tab strip `min-h-7` / a **22px meta row** / 12px gaps.
- **Stage 1b uses the low-churn variant** (review comment 4): keep the
  `ResultsPanel` title/subtitle header markup as-is and add a 22px spacer (or
  a compact `Blood Test Results · {date} · {clinic}` line rendered by
  `BloodTestDetails` while the card keeps its title — pick the simpler during
  implementation). No `ResultsPanel` API change.
- **Deferred (future polish, not Stage 1)**: hoisting the title/subtitle out
  of `ResultsPanel` and swapping its card header for a toolbar
  (`N results · M flagged`). It aligns identically but rewrites
  `results-panel.test.tsx` (43 assertions incl. the `h2`) and
  `blood-test-details.test.tsx` — high churn for a marginal gain. Revisit
  together with the F7 duplication cleanup after the shell lands.
- Horizontal edges: both panes flush to the grid gutter; only the rail inset
  (20/28px) remains as intentional structure on the left.
- **74px precondition**: the left chips row is `flex-nowrap` +
  `overflow-x-auto` (`history-list.tsx:347-366`), so it scrolls horizontally
  instead of wrapping and stays 22px. Verify the RU compact labels at the
  narrowest `lg` sidebar (288px) in §8 (review comment 12).

### 5.6 History cards — compact + status summary (Stage 2)

Per card (status summary chips — T4; the T3 compact-card pass is skipped):

- **T3 compact-card pass skipped (owner decision 2026-09-10):** the
  `p-2.5`/`size-8`/one-line-title density change was implemented and
  reviewed but rejected on looks; cards keep their current `p-3`/`size-9`/
  three-line layout. The chip placement below applies to that existing card.
- Title row: title (`min-w-0 flex-1`) + status chips (below) at the right.

Status summary chip (only for `blood_test` events, only non-zero):

- **Reuse the existing single source of truth** (review comment 3):
  `badgeVariants` (`components/ui/badge.tsx`: `normal|low|high|abnormal`) and
  the matching icons from `components/shared/StatusBadge.tsx`
  (`Check`, `ArrowDown`, `ArrowUp`, `AlertTriangle`). There is **no
  `--status-abnormal` token**: `abnormal` deliberately reuses the `high`
  tokens (`badge.tsx`, `status-labels.ts:26-31`), so the chip reuses them
  too and disambiguates via icon/label — never an invented "amber". If a
  distinct abnormal hue is ever wanted, add `--status-abnormal[-bg]` under
  `:root`, `.dark`, **and** the `prefers-color-scheme` fallback
  (`globals.css:180-233`) in one change (invariant 1) — explicitly out of
  scope here.
- Compact chip form: `↑{n}` high, `↓{n}` low, `!{n}` abnormal, each using the
  corresponding badge variant classes.
- `aria-label`/`title` with the localized full text; `sr-only` announces all
  counts.
- Computation: extract the existing per-event matching logic
  (`history-list.tsx:131-144`) into `statusCountsAtEvent(biomarkers, eventId)`
  and memoize a `Map<eventId, counts>`; O(E x R) once per data change, so the
  abnormal filter and the chips cannot drift.
- New i18n keys (EN/RU): high/low/abnormal count labels, flagged summary.
- Server-side counts are explicitly out of scope; revisit only if event or
  biomarker counts grow by an order of magnitude.

Optional later: sticky month/day group headers in the rail (`Jun 2026`).

### 5.7 Mobile master-detail (Stage 3)

- On select below `lg`: `setSelectedEvent(id)` then scroll the details
  section into view (`scrollIntoView({ block: 'start' })`, with
  `scroll-margin-top: var(--chrome-h)`).
- A switcher bar sits above the details:
  `← History | {i}/{n} {title} | ‹ ›`, `sticky top-[var(--chrome-h)]`,
  rendered only below `lg`.
- `--chrome-h` is measured once in `useLayoutEffect` + ResizeObserver on the
  sticky chrome wrapper (correct when the header wraps, RU labels, zoom).
  Initial render before measurement uses `top-0`; a one-frame jump is
  acceptable (or SSR-render a conservative default).
- Prev/next walks the full ascending `events` array; if filter-scoped
  stepping is wanted later, lift `filteredEvents` state out of `HistoryList`.
- "History" button scrolls back to the list top (anchor on the `HistoryList`
  root).

### 5.8 Tab strip restyle (Stage 1b)

- Replace `|` separators and font-weight-only active state with the NavBar
  idiom: underline indicator, inactive `text-muted-foreground
  hover:text-foreground`. **Implemented deviation (T2):** the tab strip is an
  `overflow-x` scroller, which clips descendants at its padding box, so the
  bar sits at `bottom-0` over the strip's own scoped `border-b` instead of
  straddling the rule with NavBar's `-bottom-px` (that exact class only works
  on a non-scroller). Visually identical; §5.8 is the record.
- `role="tablist"` / `role="tab"` / `aria-selected` on the buttons and
  `role="tabpanel"` on the content. `aria-controls` on each tab targets the
  lazily-mounted active panel (the APG lazy pattern); ids are `useId`-based.
  The toggles stay normal Tab-reachable buttons; **no** roving-tabindex/
  arrow-key machinery (review comment 7: complexity with little a11y gain for
  static in-page toggles — revisit only if an audit asks).
- `flex-nowrap overflow-x-auto px-1` with edge fades (same pattern/`chipsRef`
  technique as the type chips at `history-list.tsx:47-68`) for long RU labels;
  no wrap, no orphan separators. The type identity chip stays at the left,
  followed by a gap, then tabs.
- On activation/focus, `scrollIntoView({ inline: 'nearest', block: 'nearest' })`
  on the active tab so it is never left under an edge fade (review comment 8);
  `block: 'nearest'` prevents a vertical jump when the page itself can scroll
  (below `lg`).
- The tab scroller and the nowrap chips row both use the shared
  `@utility scrollbar-none` (`globals.css`: `scrollbar-width: none` +
  `::-webkit-scrollbar { display: none }`), so neither shows a classic
  scrollbar on any platform.

---

## 6. Staged plan

Stage 1 is split into 1a/1b so the risky shell restructure is reviewed alone
(review comment 10).

### Stage 1a — pure shell (this stage)

1. `TimelineView.tsx`: root flex column (`lg:h-screen`), sticky chrome
   wrapper, `print:*` guards.
2. `TimelineView.tsx` (`TimelineContent`): `main` `flex-1 min-h-0` + pane
   constraints + `print:*` guards; verify `/demo` degrades to page scroll.
3. `HistoryList.tsx`: self-contained flex column + list scroller (markup
   only; no card redesign, no header restyle yet).
4. `BloodTestDetails.tsx`: root `min-h-0` cleanup, per-tab scrollers, `px-6`
   removal, `flex min-h-0` wrappers for the other detail views.
5. `ResultsPanel.tsx`: flex card, `shrink-0` header, scrollable table region,
   sticky **opaque** column header; title/subtitle markup unchanged.
6. Fix the `<640px` search width now (`results-panel.tsx:235` — e.g. base
   `w-40`, `sm:w-64`) since the markup is already being touched (review
   comment 9).

Acceptance (1a): window scroll eliminated at `lg+`; header/nav pinned; panes
scroll independently; table header pinned; document viewer fills; no
horizontal page scroll; `/demo` unchanged; direct print preview not clipped.

### Stage 1b — alignment + tab restyle (next commit)

7. Alignment spec §5.5 (heading `px-0`, 22px meta row/spacer).
8. Tab strip restyle + minimal ARIA (§5.8), including
   `scrollIntoView({ inline: 'nearest' })`.
9. Tests touched in 1b: `blood-test-details.test.tsx` (tabs), and only if the
   spacer variant changes text placement, `results-panel.test.tsx`.
   `history-list.test.tsx` is untouched until Stage 2.

Verify per section 8 at all breakpoints/locales/themes; re-check `/demo`.

### Stage 2 — history cards

- Compact card spec (5.6), status-summary chips + `statusCountsAtEvent`
  helper (chips reuse `StatusBadge`/`badgeVariants` classes; no new tokens) +
  i18n keys + unit tests for the helper; optional month groups.
- `history-list.test.tsx` updates happen here.

### Stage 3 — table + mobile

- Table polish: `tabular-nums`, numeric alignment, always-visible sort
  affordance, optional frozen first column.
- Mobile switcher, `--chrome-h` variable, select-to-detail scrolling,
  focus/scroll-margin rules.
- Optional (deferred) `ResultsPanel` title-hoist polish from §5.5.

---

## 7. Risks and mitigations

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | Percentage-height (`h-full`) behaves differently than reasoned (F2) | Verify each tab in a real browser at Stage 1; fall back to explicit `--chrome-h` calc (5.1). |
| R2 | Nested scroll panes feel trapped on trackpads | `overscroll-contain`, mobile fallback; panes remain independently scrollable but scrollbars are hidden (`scrollbar-none`), so the affordance is partially-cut content, plus edge fades on the horizontal strips (tab strip, chips row, results table) — revisit if trapping feedback says otherwise. |
| R3 | Sticky z-order regressions (popovers under content, table header over frozen column) | Adopt the single z-scale in 5.1; assert manually with filter popover, user menu, bell open while scrolled. |
| R4 | Test churn from alignment/tab changes | Title-hoist deferred out of Stage 1 (5.5, review comment 4); Stage 1a keeps `ResultsPanel` markup intact; 1b touches only the tab markup/tests; keep all pinned EN strings. |
| R5 | Mobile switcher offset wrong when chrome wraps | ResizeObserver `--chrome-h`; conservative default; verify at 390px RU + zoom. |
| R6 | Sticky header + horizontal scroll edge artifacts | Opaque `bg-card`, `min-w` wrapper, edge fades (`scrollbar-none` hides the bar), test at 1024/1280 with the table scrolled to both ends. |
| R7 | Virtualization pressure | Data sizes are tens; explicitly deferred. |
| R8 | Keyboard users cannot scroll panes | `tabindex=0` + `role=region`/label on the primary scrollers (history rail, results region); `scroll-padding-top` on the pane so focus is never hidden under sticky headers; the remaining scrollers are reached via their focusable content (Chrome also auto-focuses scrollers). |
| R9 | Direct Ctrl+P of the timeline clips panes via `lg:h-screen`/`overflow-hidden` | `print:h-auto print:overflow-visible print:static` guards throughout the shell (5.1); print-preview check at A4 portrait + landscape (§8). |
| R10 | Focus rings / edge fades clipped by pane `overflow-hidden` | `scroll-padding-top` on scrollers, `scrollIntoView({inline:'nearest'})` for tabs, internal `pb-1`/`pr-1` breathing room; verify in the keyboard pass (§8 item 10). |
| R11 | `/demo` no longer behaves as today | Guarantee + verify the page-scroll degradation (5.1, §8 item 6); escape hatch: a `layout?: 'shell' \| 'page'` prop on `TimelineContent`. |

---

## 8. Verification and acceptance criteria

Automated: `pnpm lint`, `pnpm typecheck`, `pnpm test` (all from `frontend/`).

Manual matrix (each at 1920, 1440, 1280, 1024, 768, 390; EN + RU; light + dark;
browser zoom 100% + 125%):

1. No horizontal page scroll; no clipped content at 1024 (table may scroll
   horizontally inside its card); no visible scrollbars in either pane (the
   filter popover keeps its own) and the results table stays horizontally
   operable via the edge fades / trackpad / shift+wheel.
2. Header/nav pinned at `lg+`; both panes scroll independently; switching
   events never requires scrolling the history pane (select the oldest event,
   scroll the table to its end, verify the history list did not move).
3. Table column header stays visible while rows scroll; search field stays
   visible; sticky header is opaque over rows and merged-group headers.
4. Document tab: viewer fills the pane; no page scroll. Settings tab scrolls.
5. Keyboard: tab order reaches both scrollers; focused controls are not
   obscured by sticky chrome (`scroll-padding-top`); tab widget arrow keys.
6. `/demo`: unchanged page-scroll behavior (graceful degradation of the
   shell utilities); no internal scrollers activate; no runtime errors.
7. Direct print preview of the timeline page at A4 portrait + landscape: no
   clipping/blank panes (print guards in 5.1).
8. RU + EN at the narrowest `lg` (sidebar 288px): chips row stays 22px (no
   wrap), tabs scroll under the fades, active tab visible when focused.
9. Search input usable at 390px (no collapsed intrinsic width).
10. Keyboard focus rings not amputated by pane edges; focused controls not
    hidden under sticky headers.
11. Loading/error states still render (unchanged bare-text treatment).
12. Print editor output unaffected.

---

## 9. Open questions

1. ~~Hoist the results identity/meta row?~~ **Resolved** (review comment 4):
   deferred out of Stage 1; Stage 1b uses the spacer/low-churn variant (5.5);
   revisit with the F7 duplication cleanup.
2. Frozen Biomarker column at narrow widths: worth the z-order complexity?
3. Month grouping in the rail: Stage 2 or later?
4. Status summary display: three directional chips (`↑2 ↓1 !1`, proposed,
   reusing `badgeVariants`) vs. a single "3 flagged" chip with a breakdown
   tooltip.
5. Should the sticky chrome show a condensed variant on scroll (e.g. smaller
   patient row) or stay full height?
6. Sticky-pane alternative (§4/§5.1): what user-feedback signal (R2) should
   trigger switching to it?

---

## 10. Reviewer critique and responses

**Run:** `opencode-go/hy3`, `--variant max`, read-only `plan` agent,
2026-09-10, working dir = repo root. The reviewer independently read every
cited source file plus `event-visuals.ts` and `architecture.md`, then
produced 13 comments. (`opencode-go/omen-alpha`, originally requested, is
stale in the global agent configs and errors server-side; the owner approved
hy3 as the substitute. `--pure` was used because a local plugin crashes
nested `opencode run` sessions.)

### 10.1 Comments and dispositions

1. **[BLOCKER] §5.1 scope is false** — `main`/`aside`/`section` live inside
   `TimelineContent` (`TimelineView.tsx:97-111`), which `/demo` also renders;
   "TimelineView only, so /demo is untouched" was wrong.
   → **Accepted.** §5.1 rewritten: the change spans `TimelineView` (root +
   chrome) and `TimelineContent` (panes); `/demo` is a documented
   graceful-degradation guarantee with a `layout` escape hatch; verified in
   §8 item 6; R11 added.
2. **[MAJOR] Print clipping** — `lg:` is a min-width query and matches print
   at >=1024 CSS px (A4 landscape ~1123px); `lg:h-screen`/`lg:overflow-hidden`
   can clip a direct Ctrl+P.
   → **Accepted.** `print:h-auto print:overflow-visible print:static` added
   across the shell in §5.1; verification in §8 item 7; R9.
3. **[MAJOR] No `--status-abnormal` token; "amber" invented** — abnormal
   already reuses the `high` tokens; a new color risks the channel contract.
   → **Accepted.** §5.6 drives the chips from `StatusBadge`/`badgeVariants`
   classes + the same icons; abnormal reuses high tokens; adding a new token
   is explicitly out of scope (and, if ever done, requires all three token
   blocks).
4. **[MAJOR] Title-hoist churn outweighs its gain** — rewrites
   `results-panel.test.tsx` (43 assertions) and `blood-test-details.test.tsx`.
   → **Accepted.** Stage 1 uses the spacer/low-churn fallback; the hoist is
   deferred to future polish; §5.5, §6, §9 updated; R4 updated.
5. **[MINOR] F2 reasoning imprecise** — `h-full` against an indefinite
   auto-sized row resolves to `auto`, not to the stretched row height.
   → **Accepted.** F2 corrected with the reviewer's wording; conclusion and
   fix unchanged.
6. **[MINOR] Residual 4px horizontal mismatch** — the History heading keeps
   `px-1` after `px-6` is dropped from the details pane.
   → **Accepted.** §5.5: heading `px-0`.
7. **[MINOR] Over-specified tab ARIA** — roving tabindex + arrow keys for
   three static toggles add churn for little a11y gain.
   → **Accepted.** Dropped; `role=tablist`/`tab`/`aria-selected` retained;
   §5.8 updated.
8. **[MINOR] Focused tab can hide under the edge fade.**
   → **Accepted.** `scrollIntoView({ inline: 'nearest' })` added to §5.8.
9. **[NIT] Fix the <640px search collapse in Stage 1, not Stage 3.**
   → **Accepted.** Moved into Stage 1a item 6; §6 updated.
10. **[MAJOR] Stage 1 over-bundles risky work vs decision D4.**
    → **Accepted.** Split into 1a (pure shell, markup-only panes) and 1b
    (alignment + tabs); acceptance re-scoped; §6 rewritten.
11. **[MINOR] The sticky-pane alternative was not considered.**
    → **Accepted as a documented fallback, not adopted.** Added to §4 and
    §5.1 with why it lost (desktop `--chrome-h` dependency from day one,
    sticky-in-grid handling) plus the trigger question in §9 item 6.
12. **[NIT] The 74px math assumes the chips row never wraps.**
    → **Accepted.** Nowrap makes the row scroll rather than wrap; the
    precondition is stated in §5.5 and verified for RU at 288px in §8 item 8.
13. **[MINOR] Focus rings clipped by `overflow-hidden`.**
    → **Accepted.** R10 + §8 item 10 (`scroll-padding-top`, internal
    `pb-1`/`pr-1`).

### 10.2 Verdict adopted

Keep in Stage 1a: the height model (scope now corrected), self-contained
panes, per-tab scrollers, sticky opaque table header, the shared detail-view
wrapper, and the print guards. Cut from Stage 1: the title-hoist (deferred),
the full tab a11y (simplified to roles + underline), and the <640px search
fix moved into 1a. Stage 1b carries alignment + tab restyle. The
`--status-abnormal` gap is resolved by reusing `StatusBadge`/`badgeVariants`.
The verification matrix now covers print (portrait + landscape), RU chips at
the 288px sidebar, search at 390px, and focus-ring clipping.

---

## Appendix A — evidence index

| Area | File:line |
|---|---|
| Page root, grid | `src/views/TimelineView.tsx:22,98,103,111` |
| Loading/error states | `src/views/TimelineView.tsx:83,91` |
| Chrome | `src/components/health-passport/header-bar.tsx:76`; `src/components/shared/NavBar.tsx:29` |
| History root/header/chips/popover | `src/components/health-passport/history-list.tsx:178,179,203,365` |
| Rail rows, cards, meta | `src/components/health-passport/history-list.tsx:454,462,492,510-519` |
| Abnormal-only matching | `src/components/health-passport/history-list.tsx:131-144` |
| Details root/tabs/wrappers | `src/components/health-passport/blood-test-details.tsx:50,78,79,128,132,202,209` |
| Results grid/header/table | `src/components/health-passport/results-panel.tsx:29,225,226,235,246,247,251,380,440` |
| Input base | `src/components/ui/input.tsx` (`h-8 w-full`) |
| Tokens/gutter | `src/app/globals.css:97,107,259` |
| Channel contract | `frontend/docs/architecture.md` "Event-type visual language" |
| Merged semantics | `frontend/docs/architecture.md` "Merge UI + merged-readings sections" |
| Recent alignment commit | `2744608` (timeline alignment claim) |
