# Timeline UI/UX — implementation tickets

Companion to `frontend/docs/timeline-ui-design.md` (findings, design, external
review record). Status legend: `[ ]` open, `[~]` in progress, `[x]` done.

Each ticket is independently shippable and leaves lint/typecheck/tests green.
Observable-contract changes (none expected) would also update
`frontend/docs/architecture.md` per the AGENTS.md doc rule.

---

## T1 — App shell + self-contained scroll panes (Stage 1a) — `[x]`

**Status:** shipped 2026-09-10; external review addressed (see dispositions).
**Depends on:** none. **Blocks:** T2–T6.
**Design refs:** §5.1, §5.2, §5.3, §5.4, §6 Stage 1a.

### Goal
Eliminate the single document scroll on desktop: pin the page chrome and give
history and details independent scroll containers with a definite height
model, without touching the visual design or the demo surface behavior.

### Deliverables
- `TimelineView.tsx`:
  - root becomes a flex column (`lg:h-screen lg:min-h-0 lg:overflow-hidden`,
    `print:*` guards);
  - `HeaderBar` + `NavBar` wrapped in a `sticky top-0 z-40 lg:static`
    container.
- `TimelineContent` (`TimelineView.tsx`):
  - `main` gains `w-full flex-1 min-h-0 lg:overflow-hidden` + `print:*`
    guards;
  - `aside`/`section` gain `lg:min-h-0 lg:overflow-hidden` + `print:*`
    guards; visit/instrumental branches get a `flex h-full min-h-0 flex-col`
    scroll wrapper; procedure/no-detail stubs unchanged.
- `history-list.tsx`: root `flex h-full min-h-0 flex-col`; title + chips stay
  fixed; the rail list moves into a `min-h-0 flex-1 overflow-y-auto
  overscroll-contain` region (`role="region"`, `tabIndex={0}`).
- `blood-test-details.tsx`: drop `px-6`; add `min-h-0`; results wrapper
  becomes `flex min-h-0 flex-1 flex-col`; settings wrapper scrolls;
  document tab keeps the viewer full-height with a scrollable attachment
  list.
- `results-panel.tsx`: Card becomes `flex h-full min-h-0 flex-col`; header
  `shrink-0`; table region `min-h-0 flex-1 overflow-auto`; column header row
  `sticky top-0 z-10 bg-card` (opaque); search wrapper gets a base width
  (`w-40`, `sm:w-64`).
- `/demo` must degrade to today's page scroll (guarantee, verified).

### Non-goals
Card redesign, tab restyle, alignment changes, table typography/alignment,
mobile switcher, any new i18n keys, backend changes.

### Acceptance criteria
- At `lg+`: no window scroll; header/nav always visible; history and details
  scroll independently; table column header stays visible while rows scroll;
  document viewer fills the pane; settings tab scrolls.
- Below `lg` and on `/demo`: document scroll unchanged; no internal scrollers
  activate.
- No horizontal page scroll at any width; the results table still scrolls
  horizontally inside its card below the `768px` minimum.
- Direct print preview of the timeline (A4 portrait + landscape) is not
  clipped by the shell.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

### Verification notes
- Manual matrix: 1920/1440/1280/1024/768/390, EN + RU, light + dark.
- Select the oldest event, scroll the table to its end, confirm the history
  pane did not move.
- Open the filter popover and the user menu while scrolled: z-order intact.

### Review dispositions
External review run 2026-09-10 (`opencode-go/deepseek-v4-flash`, `--variant
max`; `openrouter/deepseek/deepseek-v4.1-flash` was unaffordable with the
account's OpenRouter credits and `opencode-go/omen-alpha` is stale/unavailable).
Verdict: **fix-then-ship** — all 12 comments addressed:

- **BLOCKER** root missing print guards -> `print:h-auto print:overflow-visible`
  added to the root; compiled-CSS order re-verified (`print:*` after `lg:*`).
- **MAJOR** filter popover clipped by pane `overflow-hidden` -> aside's
  `lg:overflow-hidden` removed; popover self-caps with
  `max-h-[min(32rem,calc(100dvh-7rem))] overflow-y-auto overscroll-contain`.
- **MINOR** rail scroller clipping selection ring/focus -> `px-1` added;
  attachment lists got `print:max-h-none print:overflow-visible`; table region
  got `scroll-pt-10`; behavioral tests added (history region + focusability,
  all attachment rows selectable, column header shares the scroll region).
- **NIT** `aria-labelledby` replaces the duplicated region label; explicit
  `lg:grid-rows-[minmax(0,1fr)]`; `next-env.d.ts` build flip reverted;
  DocumentViewer "fill the pane" deviation recorded in design §5.3 and added
  to T5 below; TimelineView shell smoke test added
  (`src/views/__tests__/timeline-content.test.tsx`).

Checks after the fixes: `pnpm lint` (0 errors), `pnpm typecheck`, `pnpm test`
(450 passed), `pnpm build` (Tailwind classes emitted).

---

## T2 — Alignment + tab strip restyle (Stage 1b) — `[x]`

**Status:** shipped 2026-09-10; external review addressed (see dispositions).
**Depends on:** T1. **Blocks:** none.

### Goal
Make the two panes share one visual baseline and replace the `|`-separated
detail tabs with the app's underline-tab idiom.

### Deliverables
- 74px header-zone alignment (design §5.5): History heading `px-0`; 22px
  spacer/meta row on the right; no `ResultsPanel` API change.
- Tab strip restyle (design §5.8): underline indicator, `role="tablist"` /
  `role="tab"` / `aria-selected` + `role="tabpanel"`, nowrap + edge fades,
  `scrollIntoView({ inline: 'nearest' })` on activation/focus; no roving
  tabindex.
- Update `blood-test-details.test.tsx` (and `results-panel.test.tsx` only if
  the spacer variant moves text).

### Acceptance criteria
- First history card and results card start at the same y at `lg+`; pane
  edges flush to the grid gutter.
- Active tab is unmistakable, never orphaned by wrapping; keyboard focus is
  never hidden under an edge fade.
- All tests/lint/typecheck pass.

### Review dispositions
External review run 2026-09-10 (`opencode-go/glm-5.3-flash`, `--variant max`,
read-only `plan` agent; the owner directed GLM 5.3 flash max thinking as the
reviewer instead of `opencode-go/deepseek-v4-flash`). Verdict:
**fix-then-ship** — all 6 comments addressed:

- **MINOR** design §5.8 still prescribed the literal `-bottom-px` underline
  and was silent on `aria-controls`/scrollbar treatment -> §5.8 updated with
  the scroller-clipping deviation (`bottom-0` over the strip's own scoped
  `border-b`), the lazy-panel `aria-controls` note, and the shipped
  `[scrollbar-width:none]` treatment.
- **MINOR** tab scroller had no breathing padding at scroll limits (focus
  ring clipped, the T1/R10 hazard) -> `px-1` added to the tablist.
- **MINOR** Settings tabpanel is a bare scroller but lacked the R8 focus
  affordance -> `tabIndex={0}` added (matches the history rail region).
- **NIT** inert `flex-1` on the tablist dropped; `activeTab` removed from the
  overflow-effect deps (labels don't change geometry; tab switches update
  fades via the scroll listener).
- **NIT** `aria-controls` direction unasserted -> test now pins tab→panel.
- **NIT** classic-scrollbar platforms would squash the 28px strip ->
  `[scrollbar-width:none]` + `[&::-webkit-scrollbar]:hidden` on the tab
  scroller; the chips row's pre-existing Stage 1a exposure is documented as
  deferred in §5.8.

Reviewer independently verified the 74px math at all breakpoints/locales,
scope/contracts clean (no `ResultsPanel` API, i18n, backend, or
`architecture.md` statement changed), `bottom-0` sound, and test coverage
sufficient.

---

## T3 — Compact history cards (Stage 2a) — skipped

**Status:** skipped 2026-09-10 — the compact-card direction was implemented
and externally reviewed (verdict: ship), but the owner rejected it on looks;
the card reverts to its pre-T3 layout and nothing from this ticket ships. The
anomaly-discovery goal continues in T4 (status summary only).
**Depends on:** T1. **Blocks:** none. **Design refs:** §5.6.

### Goal (abandoned)
Raise history-list density ~40% so more of the chronology is visible at once.

### Original deliverables (not shipped)
- Card `p-2.5`, bubble `size-8`, title `truncate` at `sm+` (`line-clamp-2` on
  mobile), tooltip kept.
- Meta row: date (`tabular-nums`) + clinic + inline paperclip count; remove
  the vertically-centered floating count.
- Update `history-list.test.tsx` if text structure moves.

### Acceptance criteria (not pursued)
- Card height ~56–60px for typical entries; no truncation regressions on RU.
- Selection, filters, and a11y semantics unchanged.

---

## T4 — Per-event status summary (Stage 2b) — `[x]`

**Status:** implemented 2026-09-10; lint/typecheck/tests green. External
review not run (not requested).
**Depends on:** T1 (T3 skipped). **Design refs:** §5.6.

### Goal
Surface out-of-range results per blood-test entry so anomalies are findable
without opening each card.

### Deliverables
- `statusCountsAtEvent(biomarkers, eventId)` helper extracted from the
  abnormal-only filter logic (`history-list.tsx:131-144`); memoized
  `Map<eventId, counts>`.
- Compact chips `↑n` / `↓n` / `!n` reusing `badgeVariants` +
  `StatusBadge` icons; hidden when zero; `aria-label`/`title` full text.
- New EN/RU i18n keys; helper unit tests; `history-list.test.tsx` updates.

### Acceptance criteria
- Chips match the "Abnormal results" filter results exactly (same helper).
- No new color tokens; channel contract intact (type vs status).
- i18n parity test passes.

### Implementation notes
- `frontend/src/lib/event-status.ts` (`statusCountsAtEvent`, `hasFlagged`,
  `statusCountsByEvent`) is the single source of truth for the abnormal-only
  filter and the chips; the filter now reads the memoized
  `Map<eventId, counts>`.
- Chips sit at the right of the title row (`min-w-0 flex-1` title), render on
  `blood_test` cards only, and are hidden when all counts are zero. Each chip
  reuses `badgeVariants` (`high`/`low`/`abnormal`) + the `StatusBadge` icon
  and carries a `title` with the full localized text; one `sr-only` joined
  summary announces all counts (chips are `aria-hidden`).
- Unit tests: `frontend/src/lib/__tests__/event-status.test.ts`; card-level
  chip/filter-parity tests in `history-list.test.tsx`.
- No design-doc statement changed; no new tokens, API, or backend change.

---

## T5 — Results table polish (Stage 3a)

**Depends on:** T1. **Design refs:** §F9, §5.4.

### Goal
Improve scanability of the results table and its narrow-width behavior.

### Deliverables
- `tabular-nums` + numeric alignment for Latest/Unit/Reference; status column
  alignment.
- Always-visible (low-opacity) sort affordance instead of hover-only.
- Optional: frozen Biomarker column (`sticky left-0`, z-scale per design
  §5.4) at narrow widths.
- DocumentViewer fill follow-up (from T1 review comment 6): viewer root
  `h-full min-h-0`, scroll area `flex-1 min-h-0`, drop `h-[80vh]`/`fitHeight`
  pixel sizing, then restore the detail-view wrapper to `overflow-hidden`.
- `results-panel.test.tsx` updates if needed.

### Acceptance criteria
- Column behavior stable at 1024/1280 with horizontal scroll at both ends.
- No regression in sort semantics or tier ordering.

---

## T6 — Mobile master-detail switcher (Stage 3b)

**Depends on:** T1. **Design refs:** §5.7.

### Goal
Make results reachable in one gesture below `lg` instead of scrolling past
the entire history list.

### Deliverables
- Selecting an event scrolls the details into view (`scrollIntoView`,
  `scroll-margin-top: var(--chrome-h)`).
- Sticky switcher bar (`← History | i/n title | ‹ ›`), rendered below `lg`
  only.
- `--chrome-h` measured from the sticky chrome wrapper via
  ResizeObserver/`useLayoutEffect`.
- Focus/scroll-margin rules per design §5.7/§R8.

### Acceptance criteria
- At 390px: select any card → details visible immediately; prev/next works;
  back-to-history returns to the list.
- Chrome wrapping (RU, zoom 125%) keeps the switcher correctly offset.
