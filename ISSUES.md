# HealthPassport — Bug / Inconsistency Log

Convention: when an issue is resolved, delete its entry (the git history
keeps the log traceable). When a fix makes a documented statement false (observable
contract: API shape, data model, reference/status semantics, matcher/unit
rules, proxy rewrites, merge/unit-conflict behavior, harness/safety), the
affected docs (`backend/docs/architecture.md`, `frontend/docs/architecture.md`,
`backend/e2e/README.md`, AGENTS.md invariants) must be updated in the same
change; cosmetic/mechanical and behavior-preserving fixes leave docs
untouched.

Audit date: 2026-08-02. Findings verified against the current working tree
(the e2e refactor referenced below is committed as `feca353`: frontend
Playwright e2e removed, backend serializers hoisted into
`app/api/_serializers.py`, several scripts deleted). Line numbers refer to
files as they stand now.

---

## HIGH

### 3. "Forgot password?" is a dead link; password reset not implemented

- File: `frontend/src/app/login/page.tsx:87` links to `/forgot-password`
- No such route exists (only `/login` and `/register` under `src/app`).
- Backend has no reset endpoint (`grep -ri "forgot\|reset.password" backend` → nothing).
- Clicking the link → 404 on a route that was never built.

### 8. Imaging / MRI entries are saved without any imaging data and have no detail/delete view

- `frontend/src/components/health-passport/add-entry.tsx:911-915` offers
  "MRI / Imaging Scan" and collects `imagingFormData`, but
  `buildSaveEntryFormData` (`api.ts:227-244`, used at `add-entry.tsx:510-521`)
  never appends imaging data and backend `save_entry`
  (`backend/app/api/entries.py:461-496`) has no imaging form field — no
  `ImagingData` model exists at all.
- Saved imaging entries render "No detailed view available for this event type."
  (`frontend/src/views/TimelineView.tsx:94-97`) with no Settings/Delete tab.
- Switching Document Type after an AI extraction leaves the extracted biomarker
  rows in `categories`, which are still persisted (`add-entry.tsx:518`), so an
  "Imaging" entry can silently carry invisible blood-test readings.

### 10. Print "AI translation" is cosmetic — de/fr/es/he output is English

- Files: `frontend/src/components/health-passport/print-setup.tsx:59-61,43-46`
- "AI translation of medical terminology may take a few moments." is printed,
  but "Generate Document" only does `router.push('/print-editor')` — no
  translation API call, no backend translation endpoint.
- Production definitions carry only `en` names
  (`backend/app/db/seed_loinc.py:236` seeds `{"en": …}`; `matcher.py` local
  defs are `en`-only), yet `translatedName()` (`print-editor.tsx:229-235`)
  looks up `def.names[lang]`. The unit tests pass only because fixtures
  (`backend/tests/seed_data.py`) carry full multilingual names maps. Result:
  selecting German/French/Spanish/Hebrew renders English biomarker names, and
  `he` has no translation data anywhere.

---

## MEDIUM

### 15. "Insights & Correlation" delivers no correlation and drops common cases

- File: `frontend/src/components/health-passport/correlation-chart.tsx`
- Single-measurement biomarkers — the common one-test onboarding case — are
  excluded because `history` is `[]` for them (`timeline.py:90-93`), so the
  picker is empty ("Select at least one biomarker…" shows while checkboxes stay
  ticked; `correlation-chart.tsx:99-101,118-121`).
- One-sided references (`≤ 0.7`) produce null bounds → the series is silently
  dropped with no message (`:146-158`).
- Fixed Y domain `[-20, 120]` clips values above 3× the upper bound (`:280`).
- No correlation coefficient, p-value, or regression exists anywhere; the dashed
  "bridge" (`:168-189`) invents a constant flat trend across gaps, and tooltips
  render blank rows for dates without readings.

---

## Refactors / agentic-development (2026-08-03)

Refactor candidates identified during an agentic-development audit. These are
not user-facing bugs; they increase per-task token cost for AI-assisted
development (wholesale file reads) and slow agent context loading.

### 21. Split `backend/app/services/matcher.py` (1,998 lines)

- File: `backend/app/services/matcher.py` — bundles LOINC/name matching,
  canonical-unit assignment, `_guess_unit()` heuristics, `_llm_scale_function`,
  `_apply_scale_function`, cross-scale conversion, and `verify_or_create`.
- Every matcher/unit task reads the file wholesale (~21k tokens).
- Proposal: split into focused modules (matching, units/conversion, guessing)
  behind the same public entry points, keep behavior identical, run the full
  backend suite + `validate_offline.py` after.

### 22. Split `frontend/src/components/health-passport/add-entry.tsx` (1,017 lines)

- File: `frontend/src/components/health-passport/add-entry.tsx` — bundles the
  extract SSE flow, merge checkbox/conflict detection, unit-conflict dialog
  wiring, and form-row rewriting.
- Proposal: extract merge pre-flight + conflict detection and the unit-conflict
  application into dedicated hooks/components; keep `add-entry.tsx` as the
  orchestrator.

### 23. Document the undocumented backend/frontend modules

- Backend: `app/db/models.py`, `app/db/import_ranges.py`,
  `app/services/extractor.py`, `app/services/converters.py`,
  `app/services/data_migration.py`, `app/api/anon_session.py` — referenced
  indirectly but never named in AGENTS.md or `backend/docs/architecture.md`.
- Frontend: view layer (`src/views/*` — CorrelationView, AddEntryView,
  BiomarkerDetailsView, FlowsheetView, PrintEditorView, PrintSetupView) and
  shared components (`src/components/shared/BiomarkerChart.tsx`, DocumentViewer,
  Sparkline, StatusBadge, ScaleNote) — unnamed in docs.
- Proposal: add a module map (file → purpose, 1-2 lines each) to
  `backend/docs/architecture.md` / `frontend/docs/architecture.md` so agents
  don't re-derive them via grep.

---

## Proposed features (not yet built)

### 24. Extraction benchmark module + autoresearch loop

A standalone, long-running quality/cost benchmark for the **live** extraction
pipeline (OCR → LLM extraction → matcher), driven by a project-local
autoresearch loop that autonomously improves recognition, stability, speed,
and AI-request cost. It lives in its own module so normal development can
continue while the loop runs for hours in the background.

#### Motivation

- Extraction is LLM/OCR-based and flaky (`backend/e2e/KNOWN_ISSUES.md` notes
  ~5/8 pass rates, run-to-run variance). There is currently **no numeric
  signal** for "how well does extraction recognize this document" — only
  pass/fail per golden case on a 6-case corpus.
- `validate_offline.py` skips OCR+LLM entirely (matcher-only), and
  `run_e2e.py` requires a live server + per-run flakiness. Neither gives a
  measurable, loopable metric over **many** documents.
- Goal: many medical files + hand-verified goldens → a scalar metric
  (recognition × stability) the autoresearch loop can push up, with cost
  (tokens/calls/latency) tracked as a co-metric the loop must not regress.

#### Module layout (new `backend/benchmark/`)

```
backend/benchmark/
  README.md                # how to run, metric semantics, safety rules
  corpus/<case>/           # source doc(s) + golden.json (e2e golden format)
  metrics.py               # Mistral client wrapper: counts LLM calls, tokens,
                           #   upload bytes, per-stage latency
  scoring.py               # recognition / stability / cost aggregation
  run_benchmark.py         # THE verify command (see Metrics)
```

- **Corpus seeding**: copy the 6 existing e2e cases (`backend/e2e/inputs/*` +
  `backend/e2e/golden/*/standardized.json`) as the starting corpus; grow by
  dropping more documents + goldens.
- **Isolation**: `run_benchmark.py` is a pure library runner — no server, no
  port, no HTTP — with its **own** LOINC-seeded DB and its **own** Mistral
  client, like `validate_offline.py` but with the LLM enabled.

#### Metrics (per run of the verify command)

Each case is processed **N=3 times** (flakiness measurement), then:

- **recognition** — fraction of golden biomarkers/visits/imaging items
  recognized in the observed output (via `e2e/compare.py`), averaged over
  cases; unexpected (extra) items penalize.
- **stability** — fraction of golden items recognized in ALL N runs (the
  flaky ones show up here).
- **primary** — `recognition × stability`; the loop's keep/discard metric.
- **cost** — total LLM calls, `usage.input_tokens` / `output_tokens` (the
  Mistral SDK exposes them on every `chat.parse` response — matcher makes up
  to 8 extra LLM calls beyond the main extraction), OCR upload bytes, total
  wall time.

Output is machine-readable, e.g.:

```
METRIC recognition=0.94
METRIC stability=0.88
METRIC primary=0.83
METRIC llm_calls=9
METRIC input_tokens=18430
METRIC output_tokens=5210
METRIC ocr_bytes=2415013
METRIC wall_s=92.4
```

Exit code 0 on success, non-zero on hard failure (auth/quota) so the loop can
distinguish "worse" from "broken".

#### Autoresearch loop contract

- `.opencode/skills/autoresearch/SKILL.md` — the loop procedure:
  baseline → ONE focused change → run benchmark → keep if **primary strictly
  improves** (ties broken by lower cost) else discard → guards → journal →
  repeat, capped at `max_iterations` (default 10).
- `.opencode/command/autoresearch.md` — start/resume entry point.
- **Guards** (must stay green for a keep): `pytest tests/`, `ruff check .`,
  and existing e2e goldens via `validate_offline.py`.
- **Scope-locked**: only `extractor.py`, `matcher.py`, `ai.py`, and
  `benchmark/`. **Off-limits**: `seed_loinc`, `Loinc.csv`, goldens, DB files.
- **Git isolation**: runs on its own `autoresearch/extraction` branch; main
  work is untouched. The loop **never commits to main and never pushes** —
  every keep is presented for human review first.
- State/journal: `.autoresearch/state.json` + `autoresearch.md` (gitignored),
  resumable across sessions; session auto-compaction between iterations.

#### Cost & verification notes

- Each iteration ≈ 6 cases × 3 runs × (OCR + 1–9 LLM calls) — real Mistral
  spend; `max_iterations` is a hard cap and should be tuned to a budget.
- Validation before trusting the loop: sanity-check `run_benchmark.py` on 1
  case × 3 runs against manual extraction, and dry-run the loop with a
  deliberate no-op change to confirm it discards (primary unchanged).
- Decisions made (2026-08-03): N=3 runs, strict primary improvement keep,
  separate branch isolation, build everything in one pass.

---

## Verified working (explicitly checked, no findings)

- Auth round-trip (JWT ⇄ NextAuth), anonymous-session id, `fetchAuthedObjectUrl` /
  `printAuthedDocument` for protected uploads, per-user file authorization in
  `app/main.py:57`
- Delete entry + usage counter refund; same-date merge feature & merged-readings
  sections in timeline only
- Unit-conversion dialog + flowsheet `ScaleNote` (cross-scale log↔linear); the
  merged/biomarkers-at-date flag handling (`TimelineView.biomarkersAtDate`)
- LOINC reference model (interval/qualitative), compact number formatting,
  reference editor, registration + DOB validation