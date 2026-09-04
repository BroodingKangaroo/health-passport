# Roadmap analysis — Phase 0.3 Demo mode

**Status:** FINAL — superseded in one respect: §4's seed-the-session design
was replaced during implementation by a landing-embedded demo surface (see
the decision record at the bottom). Shipped together with the 0.2 privacy
policy page and the 0.5 AGENTS.md correction.
**Date:** 2026-09-02 (draft 2: revised after independent review — 12
comments addressed, 2 blockers fixed: migration def-copy rule, seeded-def id
scheme). Implemented 2026-09-03.
**Source:** `docs/product-roadmap.md` §0.3.
**Question answered:** which single remaining roadmap action has the highest
ROI right now, and what exactly does implementing it involve?

---

## 1. Selection: what to do, and why this

### 1.1 Where the roadmap actually stands (verified against code)

The roadmap text predates work that has already landed. Verified state:

| Roadmap item | Claimed state | Verified state |
|---|---|---|
| 0.1 Landing page + empty state | not started | **Shipped** in commit `5182b61` (`LandingGate` on `/`, hero, badges, i18n, tests) |
| 0.2 Privacy + AI disclosure | not started | **Half shipped**: AI disclosure in `upload-screen.tsx` + `privacyNote` in the landing footer (`5182b61`). A real privacy **policy page** (landing/footer/settings links) does **not** exist |
| 0.3 Demo mode | not started | Not started (no demo code anywhere in `backend/app/` or `frontend/src/`) |
| 0.4 Password reset + email change | inert (SMTP off) | Still inert; email change still missing |
| 0.5 AGENTS.md doc-drift fix | open | Still open: `.env` / `.jwt_secret` **are** gitignored (`git check-ignore` confirms) while AGENTS.md claims they are committed |
| Migration gap note (0.3 & Phase 5) | "`copy_anonymous_data` does not copy `InstrumentalData`" | **Stale — gap is fixed** (`backend/app/services/data_migration.py:136-150` copies `InstrumentalData`) |
| "8 real lab documents" (0.3) | 8 | 9 documents in `backend/e2e/inputs/` |

So the conversion funnel now exists end-to-end: visitor → hero → "try without
account" → anonymous session → real upload → 5 free extractions
(`ANONYMOUS_LIMITS` in `backend/config.py`).

### 1.2 Candidate ranking

| Candidate | Effort | Impact now | Why now / why not |
|---|---|---|---|
| **0.3 Demo mode** | **M** | **High** | The funnel's next cliff is "hand over your *real* medical document as your very first action." Demo mode removes that cliff. Everything else downstream (share links, explanations) is experienced *after* this moment. |
| 0.2 remainder: privacy policy page | S | Low–Med (now), **blocking for launch** | Not a conversion lever at current ~zero traffic, and the upload-point disclosure already covers the deal-breaker — but the roadmap's own Safety guardrails require it "live before public launch." **Sequencing rule in §1.4.** One afternoon of copy + a page; rides along with any change. |
| 0.4 SMTP + email change | M + ops | Med | Reset already works (logs). Needs a real SMTP decision that is ops, not code. Value accrues only once there are registered users to lock out. |
| 0.5 AGENTS.md fix | XS | XS (dev-only) | Do it as a rider on this change, not as the action itself. |
| 0.6 Timeline scannability | M | Med | Polish; improves the product *after* someone has data. Demo mode fills the timeline first. |
| 1.1 Share links | L | High | The killer feature — but it amplifies a funnel that must first convert. Roadmap explicitly orders Phase 0 first. |
| 1.2 AI explanations | L | High | Largest cost/safety surface (Mistral spend, medical-advice guardrails); premature before users exist. |

**Decision: implement 0.3 Demo mode now**, bundling 0.5 (one-line AGENTS.md
correction) as a rider.

### 1.3 Why demo mode is the highest-ROI action

1. **It attacks the single riskiest moment in the funnel.** Today a
   first-timer's first extraction runs against a document they care about. If
   OCR or matching misreads it, the product's first impression is *getting
   their medical data wrong* — the worst possible first impression, and one
   they may not retry. Demo mode converts the trial from "trust us with your
   real lab PDF" to "watch it work on a sample, then upload yours."
2. **It is the concrete embodiment of marketing principle 4** ("Show, don't
   ask for trust") and principle 6 (calm, glanceable design): the user sees a
   populated timeline, statuses, and details *before* risking anything.
3. **It serves the priority persona.** "Regular people" evaluating the product
   — precisely the AI-hesitant audience of principle 5 — will not upload a
   document to an unknown site on day one.
4. **It is cheap to run.** The roadmap constraint "no Mistral spend for the
   demo path" is achievable with assets that already exist: golden
   standardized data (`backend/e2e/golden/<case>/standardized.json`) captures
   the pipeline's own output (per-reading raw/standard values, references,
   statuses). It needs curation before use as a fixture (§4.2) — it is the
   raw material, not a drop-in seed.
5. **It reuses proven machinery.** Anonymous sessions (HMAC-signed cookies),
   the anon→registered migration (`copy_anonymous_data`), whole-entry delete,
   and the EN/RU catalog system all exist. The net-new surface is one flag,
   two small endpoints, a seed fixture, and UI labeling.
6. **It unlocks marketing assets** (screenshots, a "try the demo" link in
   posts) that 0.1's hero cannot currently deliver honestly — *gated on the
   sequencing rule below*.

### 1.4 Sequencing rule (trust work vs. traffic work)

This change is intended to create the first real traffic (§1.3.6). The
roadmap's own safety guardrails make a live privacy policy a **precondition
for public launch**. Therefore:

- **Shipping demo mode** does not depend on the privacy policy page.
- **Any public announcement / link-dropping that drives traffic to the demo
  is gated on the 0.2 remainder (privacy policy page) landing first.**
  Recommended: bundle the privacy policy page (copy + a static page linked
  from landing footer, app footer, and settings) into the same release train
  as this change, so the gate is closed by the same PR series rather than by
  discipline.

---

## 2. Problem statement

A first-time visitor who clicks "Try without account" lands on an empty
upload screen. To see *anything* the product does, they must:

1. locate a real medical document,
2. consent (implicitly) to cloud AI processing of it,
3. spend one of their 5 free extractions,
4. and hope the result is correct.

Each step can end the session. Demo mode replaces steps 1–4 with one click and
zero risk, so the first "wow" (a decoded timeline with statuses) happens
before any commitment. The user's real first upload then happens from a
position of demonstrated competence, not hope.

---

## 3. Verified current-state assets this builds on

- **Anonymous sessions**: `backend/app/api/anon_session.py` — signed cookie,
  session-as-principal via `get_current_user_or_anon`
  (`backend/app/api/auth.py:121`); every endpoint is tenant-scoped through it.
- **Golden standardized data**: `backend/e2e/golden/<case>/standardized.json`
  — persisted extraction output per input document. Per-reading fields only
  (`raw_*`, `standard_*`, `reference`, `status`, `definition_id`,
  `scope`); **no def-level state** (no `names` JSON, no `canonical_unit` /
  `canonical_kind` / `synonyms`) and readings resolve to `scope:"global"`
  LOINC defs. No single golden case contains both `biomarkers` and
  `visit_data` — the fixture synthesizes from two cases. See §4.2.
- **Local-def id scheme**: `local-{user_id}-{md5(normalized_name)}`
  (`backend/app/services/matcher/definitions.py:209`; same deterministic
  resolution in the manual add-entry path `entries.py::_resolve_definition`),
  and local-unification matches locals by name
  (`backend/app/services/matcher/pipeline.py` `match_local_def`). Seed-created
  defs must reuse this scheme (§4.3).
- **Status is computed at save time and persisted**; the seed reuses the same
  status logic rather than trusting fixture statuses.
- **Migration service**: `backend/app/services/data_migration.py`
  (`copy_anonymous_data`) — copies **all** local defs of the anon user
  (lines 67-95, filtered only by `user_id` + `scope=="local"`), not merely
  referenced ones. The demo-skip rule must therefore be reference-driven
  (§4.4).
- **Entry deletion**: `DELETE /api/entry/{id}` (`entries.py:811`) deletes the
  entry and cascades children; it does **not** delete defs (orphaned local
  defs are the accepted artifact class Phase 3.2 targets).
- **Merge**: `POST /api/entry/{id}/merge` (`entries.py:683`) accepts any
  caller-owned `blood_test` target — it does not exclude demo entries, so a
  guard is needed (§4.3).
- **Quota plumbing**: `UsageLimit` model + `/api/usage/limits`; the hero
  already reads the trial limit (`fetchUsageLimits`).
- **Wire schema**: `MedicalEvent` (`backend/app/schemas/medical_event.py:29`)
  and `_events_from_db` (`backend/app/api/timeline.py:65`) carry no
  `is_demo` — the field must be added end-to-end for labeling (§4.5).
- **i18n**: EN/RU catalogs in `frontend/src/i18n/messages/` with the parity
  test; components under test need `TestI18nProvider`.
- **Auto-migration**: new columns on existing DBs are added by
  `migrate_add_columns()` (`backend/app/db/session.py`), called from
  `init_db`.

---

## 4. Design

### 4.1 Scope (v1)

- Two seeded entries from a curated fixture: one **blood test** (biochem
  panel with statuses) and one **doctor visit** (visit_data). This shows both
  major event types, statuses, and the detail views. (Two golden cases are
  required — no single case has both shapes.)
- **No attachments in v1.** Golden inputs are real people's documents; bundling
  them as demo attachments adds privacy surface and file-serving complexity for
  marginal wow. The timeline + biomarker details are the product story.
  (Bundling a *synthetic* PDF later is a candidate.)
- Available to **anonymous sessions and zero-entry registered accounts**
  (the landing hero shows for both).
- Demo rows are **labeled everywhere in-app data is displayed** (§4.5) and
  **one-click removable** (per-row delete + "remove all demo data").

Out of scope (deferred): demo attachments, per-biomarker curated narrative
text (that overlaps 1.2), multi-document demo histories.

### 4.2 Data source: curated fixture derived from golden, not live extraction

- New file `backend/app/demo/seed_data.json`, **derived from** two golden
  cases (blood test + doctor visit) but curated. Golden standardized data is
  per-reading only, so the fixture **synthesizes def rows** (names EN+RU,
  `canonical_unit`, `canonical_kind`, category) and **re-scopes** readings
  from their golden global LOINC defs onto the fixture's local defs:
  - **Scrub all real-world content.** Not just clinic/doctor names: the
    doctor-visit case's verdict/notes/recommendations are the maintainer's
    own medical narrative — fictionalize the entire visit narrative. Lab
    **values may be perturbed** (safe: status is recomputed at seed time
    from the reference, not copied). Fixture review checklist: "no
    real-world identifiers, no real clinical narrative."
  - **Relativized dates.** The fixture stores day-offsets (e.g. D-30 / D-7
    preserving the spread), not absolute dates — golden dates (2026-05) would
    age the demo. Seed computes actual dates at seed time. Status
    computation is date-independent, so this is free.
  - **Bilingual names.** Definitions carry `names` as JSON; the fixture ships
    both EN and RU names so the demo is presentable in both UI locales
    without invoking the translation flow.
  - **`source_language`**: seeded blood-test entry carries `"ru"` (it
    stands in for a Russian-language lab printout; the print UI's
    "original" column labels derive from it).
  - **Exclusions**: any reading flagged `needs_review`, and any merge
    artifacts, are dropped during curation; the fixture-shape test asserts
    their absence.
- Entry-level save-path fields are set to what a real extraction produces:
  `status="Completed"`, `category="Labs"` (blood test), so demo entries are
  indistinguishable from real ones except by design (§4.5).
- A **fixture-shape test** validates the JSON against the models (all
  biomarker ids resolvable, references well-formed per `kind`, no
  `needs_review`, entry fields present) so a stale fixture fails tests, not
  the user. The fixture is a *copy*, deliberately decoupled from the golden
  harness — golden files may change as the matcher improves; the demo
  experience must not.

Why not seed straight from `backend/e2e/golden/` at runtime: the harness owns
those files (a regen would silently change the demo), they contain real
identifying strings and real clinical narrative, they lack def-level state,
and runtime coupling between e2e assets and a user-facing feature is the
wrong dependency direction.

### 4.3 Backend

**Schema.** One new column: `MedicalEntry.is_demo` (Boolean, nullable=False,
default False), added via `migrate_add_columns()`.

Deliberate choice: **`is_demo` lives on `MedicalEntry` only** — not on
readings or definitions.

- Readings inherit demo-ness through their entry; a `readings.is_demo` flag
  would risk demo/real readings mixing under one entry (see the merge guard
  below, which prevents that mixing server-side).
- Definitions are *reusable product state* and are **not** marked. Seeded
  defs **reuse the deterministic local-def id scheme**
  `local-{user_id}-{md5(normalized_name)}` (`definitions.py:209`), so a later
  real extraction or manual entry of the same novel analyte **collapses onto
  the seeded def** instead of creating a duplicate local. Intended matching
  behavior, made explicit:
  - **LOINC-covered analytes** (most of the fixture) resolve globally during
    extraction and never touch demo-created locals — after purge those locals
    orphan, which is the already-accepted artifact class (3.2).
  - **Novel analytes** reuse the seeded local via the deterministic id /
    local name index, anchoring the canonical unit from the fixture's
    curated values — the same anchor semantics as any first-seen def.
  - **Manual add-entry** fuzzy-matches the session's own locals by name
    (`entries.py::_resolve_definition`), so a manual row can bind to a seeded
    def and inherit its `reference` as fallback. Accepted and intended.

**Endpoints** (new `backend/app/api/demo.py`, both under
`get_current_user_or_anon`, both quota-inert — they never touch
`UsageLimit`):

- `POST /api/demo/seed` — **409 if the session already has any entry** (demo
  is a first-run experience; the server-side guard keeps state clean even if
  a stale client calls it). Creates the two entries + readings + local
  definitions from the fixture, computing `status` via the save-path logic.
- `DELETE /api/demo/purge` — deletes all `is_demo=True` entries of the
  session, then cleans up **only defs whose every reading was demo**,
  computed non-vacuously: before deleting the entries, collect the def ids
  referenced by the session's demo readings; after deletion, delete those
  local defs whose reading count is now zero. This never touches unrelated
  orphans (a def orphaned by an earlier *real* entry deletion has no demo
  readings, is not in the candidate set, and its canonical-unit anchor
  memory survives) and never touches defs carrying real readings.
- **Merge guard**: `POST /api/entry/{id}/merge` refuses an `is_demo` target
  (409, localized detail) — a real upload must not merge readings under an
  entry the UI labels as demo. The reverse is impossible by construction
  (merge is always initiated from a new upload; demo entries are never
  merge sources).

**Migration rule.** `copy_anonymous_data` skips `is_demo=True` entries and
their readings. Because that service copies **all** local defs
(`data_migration.py:67-95`), it is made reference-driven: collect the
`biomarker_id`s of the **surviving (non-demo) readings** and copy only local
defs in that set. A def referenced by any real reading survives (and carries
its canonical-unit anchor); demo-only defs are not copied. Net effect: a
user who registers after playing with demo gets a clean account, while a
user whose real extractions reused a seeded def keeps that def.

**i18n on the API surface**: error/success `detail` strings via
`app/i18n.py` catalog keys (EN/RU by `Accept-Language`), per the response
localization invariant.

### 4.4 Frontend

- `LandingHero` gains a secondary CTA **"Load demo data"** (shown to
  not-yet-registered visitors and zero-entry accounts; the registered CTA row
  keeps "Try now" primary). Clicking calls `POST /api/demo/seed`; on success
  **or 409** (data already present), the timeline query is invalidated so
  `LandingGate` re-evaluates and flips to `TimelineView` — the hero renders
  *at* `/`, so no navigation is needed, only a refetch. Loading state on the
  button throughout.
- **Demo labeling** (`is_demo` flows through the wire schema, §4.5): a small
  "Demo data" chip, EN/RU, visually quiet (muted chip, not a status color —
  the status/type color channels stay semantic per 0.6's rule).
- **Removal affordances**: per-entry delete already exists and works on demo
  rows; additionally a "Remove demo data" action in the settings profile card
  (and/or next to the demo badge) calling `DELETE /api/demo/purge` with a
  confirm step.
- All strings via the EN/RU catalogs (`landing.ts`, timeline-adjacent,
  `settings`) with parity-test coverage; tests wrap in `TestI18nProvider`.
- No changes to `biomarkersAtDate` semantics, merged-reading display rules,
  or status colors: demo readings are ordinary readings of demo entries.

### 4.5 Labeling contract (complete surface list)

`is_demo` is added to `MedicalEvent` (`schemas/medical_event.py`) +
`_events_from_db` (`timeline.py`) + the frontend TS event types. Where it is
displayed:

| Surface | Treatment |
|---|---|
| Timeline row, details header, flowsheet row, correlation view | "Demo data" chip (muted) |
| `GET /api/export` (JSON) | `is_demo` field included on entries — data ownership means complete export; consumers filter |
| Print editor | Demo entries appear in the source list with the chip; the printed output itself is user-curated and carries no badge |

This makes the labeling rule "every in-app surface that lists entries shows
the chip; exports carry the flag; print output stays clean" — no surface
shows demo data silently.

### 4.6 The rider: 0.5 AGENTS.md correction

Change "committed dev-only secrets" to "gitignored dev-only secrets" for
`backend/.env` / `backend/.jwt_secret` (verified: both are gitignored). One
line, zero risk, roadmap-sanctioned to ride along with trust-adjacent work.

---

## 5. Effort estimate

| Work item | Size |
|---|---|
| `is_demo` column + `migrate_add_columns` wiring | XS |
| Fixture derivation + scrubbing + fictionalized narrative + EN/RU names + relativized dates | M (curation is the bulk; ~2 entries, ~15 biomarkers) |
| `POST /api/demo/seed` + `DELETE /api/demo/purge` (incl. non-vacuous def cleanup) + merge guard + i18n keys | S–M |
| `copy_anonymous_data` reference-driven demo-skip + tests | S |
| Wire schema: `is_demo` through `MedicalEvent` / timeline serializer / frontend types | S |
| Backend tests (seed, purge, 409, merge guard, migration-skip, fixture validation, quota untouched) | S |
| Hero CTA + demo chip on all in-app surfaces + purge UI + catalogs + component tests | M |
| Doc sync (backend/frontend architecture docs + roadmap status) | S |

Net: roughly a focused day–day-and-a-half of implementation. No new
dependencies, no extraction-pipeline changes, no e2e-golden impact.

---

## 6. Risks & mitigations

1. **Fixture carries real personal data or real clinical narrative.** →
   Mandatory scrubbing beyond names: fictionalized visit verdict/notes/
   recommendations, optionally perturbed values (§4.2); fixture review
   checklist in the PR.
2. **Fixture drifts from pipeline reality** (statuses/units the current save
   path wouldn't produce). → Status computed by the real save path at seed
   time; fixture-shape test validates references/ids/entry fields; decoupling
   from golden prevents *silent* drift.
3. **User confusion: "whose data is this?"** → Chip on every in-app listing
   surface (§4.5) + removal affordances; the hero CTA copy says what demo
   data is before seeding.
4. **Demo defs pollute accounts or distort matching.** → Deterministic id
   scheme makes real extractions collapse onto seeded defs (no duplicates);
   LOINC-covered analytes bypass locals entirely (accepted orphan class);
   migration copies only real-referenced defs; purge cleanup is scoped to
   demo-only defs. Residual orphan LOINC-covered locals after purge are the
   accepted 3.2 class.
5. **Seed abuse** (repeated seeding to inflate entries). → 409 guard makes
   seeding idempotent-in-effect; anonymous sessions are cookie-bound, so the
   blast radius is one session; no quota interaction means no cost.
6. **Quota miscount** — demo must feel free. → Endpoints never touch
   `UsageLimit`; test asserts extraction count unchanged after seed/purge.
7. **Anchor loss on purge** (destroying a def that holds a canonical-unit
   anchor for real data). → Candidate set requires ≥1 demo reading before
   purge, so real-data anchors are structurally out of scope (§4.3).

---

## 7. Verification plan

- Backend: `python -m pytest tests/ -v` (new tests: fixture validation,
  seed happy path, seed 409, purge removes demo entries + demo-only defs,
  purge preserves defs with real readings and unrelated orphans, merge
  refuses demo target, migration skips demo entries and demo-only defs but
  keeps real-referenced defs, quota untouched), `venv/bin/ruff check .`.
- Frontend: `pnpm lint`, `pnpm test` (hero CTA render/logic incl. 409 path,
  demo chip on listed surfaces, EN/RU parity).
- Manual: fresh anonymous session → hero → demo → timeline shows 2 labeled
  entries → purge → clean → register → account is clean → upload a real doc
  overlapping fixture analytes → matching behaves per §4.3 (global match for
  LOINC-covered, def reuse for novel analytes), unit canonicalization sane.
- E2E golden harness: untouched (no extraction-path changes) — consistent
  with roadmap §Verification.

## 8. Doc-sync obligations (same change)

- `backend/docs/architecture.md`: new `/api/demo/*` endpoints, `is_demo`
  column, seed/purge semantics (incl. def-cleanup scoping), merge guard,
  reference-driven migration rule.
- `frontend/docs/architecture.md`: hero demo CTA, labeling contract (§4.5),
  purge UI.
- `docs/product-roadmap.md`: mark 0.1 done + 0.2 partially done; correct the
  stale claims this analysis surfaced (InstrumentalData migration gap fixed;
  9 input docs); mark 0.3 done when merged; note the §1.4 sequencing rule
  (demo traffic gated on privacy policy page).
- AGENTS.md: 0.5 correction; no invariant statements change (demo adds a
  column and endpoints, but does not alter reference/status semantics,
  matcher rules, or persistence rules — the architecture docs carry the
  detail).

---

## 9. Decision record — as implemented (2026-09-03)

During implementation the user proposed embedding the demo **inside the
landing surface** instead of seeding the anonymous session, and that proposal
won on every axis that mattered:

| | §4 design (seed the session) | As built (`/demo` static surface) |
|---|---|---|
| Backend | `is_demo` column, seed/purge endpoints, merge guard, reference-driven migration rewrite, race guard | **None** |
| State | DB rows to label / purge / export-tag / migration-filter | None — static fixture |
| Failure modes | 409s, seed races, demo/real data mixing | Cannot fail; zero API calls |
| Privacy | Derived from (scrubbed) golden data — the maintainer's real results | Fully fictional patient, clinic, doctor, narrative, values |
| Estimate | 2–3 days | ~1.5 days (shipped with 0.2 page + 0.5 fix) |

What was deliberately **discarded** and why it is no longer needed:
`MedicalEntry.is_demo` + `migrate_add_columns` wiring; `POST /api/demo/seed`
/ `DELETE /api/demo/purge` (incl. the non-vacuous demo-only def cleanup); the
merge-into-demo 409 guard; the reference-driven `copy_anonymous_data` rule
(its orphan-def-dropping benefit can be revisited independently as a plain
bugfix); the labeling surface list (`MedicalEvent.is_demo` wire field, chips
on timeline/flowsheet/correlation, export flag) — the demo surface is
stateless, so nothing can be mistaken for the user's own data.

What was **kept** in spirit: the fixture requirements (§4.2) — fictional
persona (strengthened: golden values are the maintainer's real results, so
values are authored, not perturbed; golden data serves as format reference
only), bilingual names, relativized dates, canonical qualitative enum,
save-path entry fields — moved into `frontend/src/demo/demo-data.ts` with the
fixture-shape test relocated to `src/demo/__tests__/demo-data.test.ts`
(status↔reference consistency, full status-model coverage). The §1.4
sequencing rule was honored by shipping the 0.2 privacy policy page in the
same change. The user start-own-work transition is the banner CTA →
`/add-entry` (anonymous trial, quota untouched by construction).

Product decisions taken with the user: demo at a separate `/demo` route
(interactive, real components); hero keeps upload as the primary CTA with
"See live example" secondary; privacy policy page bundled into the same
series; measurement deferred (the demo generates no server events; revisit
when real analytics exist).
