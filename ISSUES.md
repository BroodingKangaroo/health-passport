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

## Security & correctness audit (2026-08-26)

Re-audit after commits `36dbcd0` / `8989829` / `8f89382`; all findings below
were re-verified against the current working tree. Line numbers refer to
files as they stand now. These are the five highest-priority items from the
full audit; lower-severity findings (auth-status stuck in `loading`,
DocumentViewer silent failure + pdf.js leak, upload whitelist/XSS hardening,
password-reset throttle collapse behind the proxy, TOCTOU races in
register/reset, dialog focus-trap gaps, keyboard-inaccessible rows,
open-redirect via `?callbackUrl=`, etc.) remain tracked outside this log.

### 31. Anonymous session cookie value is trusted verbatim as the authorization principal (critical)

- `app/api/anon_session.py:17-19`: the raw client-supplied cookie value is
  returned as-is and becomes `user_id` (`app/api/auth.py:125-128`) — no
  prefix check, no server-side session store, no signature. Every ownership
  filter in the app is `patient_id == user_id`, so anyone who sets
  `healthpassport_anon_id=<victim's Patient.id>` gets full read/write/delete
  on that account without any token.
- The victim id leaks, completing the attack chain without guessing:
  definition serialization includes owner `user_id`
  (`app/api/_serializers.py:46`) and flowsheet/timeline definition lookups
  deliberately ignore ownership (`app/api/flowsheet.py:111-114`). Arbitrary
  attacker-chosen cookie values also create unauthenticated rows in
  `usage_limits` / `medical_entries` / `biomarker_definitions`.
- Fix: HMAC-sign the anon cookie at issuance (or persist issued ids) and
  reject unverified values; stop emitting other tenants' `user_id` in wire
  schemas.

### 32. Translation commit endpoint lets unauthenticated callers rewrite shared global definitions (critical)

- `app/api/ai.py:707-731` (`POST /api/translate-biomarkers/commit`, reachable
  anonymously): the *visibility* filter — `(scope == "global") | (user_id IS
  NULL) | (user_id == caller)` — is reused as the **write** filter, then
  arbitrary client-supplied strings are persisted into `names[lang]`. Any
  caller can poison what every user's flowsheet/print renders. Same pattern
  applies to the `persist=True` path of `/api/translate-biomarkers`.
  `CommitTranslationItem.name` has no length cap either.
- Fix: restrict writes to `scope == "local" AND user_id == principal`;
  treat global/system defs as read-only; cap name length.

### 33. Shared `category_translation_cache` can be seeded/poisoned anonymously, with no size caps (medium-high)

- New in `8f89382`: `/api/translate-biomarkers` writes fresh heading
  translations into the shared all-users, never-invalidated
  `category_translation_cache` (`app/api/ai.py:791-796`), and cache hits are
  served *before* the LLM on every later request
  (`app/api/ai.py:715-724`). Since the endpoint is anonymous-reachable, an
  attacker can pre-seed poisoned heading translations that every user's
  print render then trusts (`source="translated"`), at only the cost of anon
  AI quota. `schemas/ai.py` caps neither the number of categories nor their
  string length → unbounded row sizes / row counts.
- Fix: require an authenticated principal for populating the shared cache
  (or key rows per user); cap string length and item count.

---

## Refactors / agentic-development (2026-08-03)

Refactor candidates identified during an agentic-development audit. These are
not user-facing bugs; they increase per-task token cost for AI-assisted
development (wholesale file reads) and slow agent context loading.

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

- **recognition** — fraction of golden biomarkers/visits/instrumental-test
  items recognized in the observed output (via `e2e/compare.py`), averaged over
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
- **Scope-locked**: only `extractor.py`, `matcher/` (the package),
  `ai.py`, and `benchmark/`. **Off-limits**: `seed_loinc`, `Loinc.csv`, goldens, DB files.
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

### 26. Category display/normalization (partially open)

- RESOLVED (translation): print/export category headings are now translated
  into the target language — distinct matrix headings ride the existing
  `POST /api/translate-biomarkers` batch under synthetic ids and come back
  per-request; the print editor resolves display labels via
  `PrintConfigProvider` + sessionStorage while grouping/order keys stay the
  raw string. Fresh translations are cached server-side in a shared
  `category_translation_cache` table (all users, no invalidation), so repeat
  headings never re-hit the LLM and a fully-cached document generates free.
- STILL OPEN (normalization): the stored `category` string itself is
  heterogeneous — LOINC-matched global defs carry raw CLASS codes ("HEM/BC",
  "CHEM") that render as cryptic headings even in English documents, while
  document-derived local defs carry the source document's own panel heading
  in its language (e.g. Russian microbiome group titles). The old issue text
  claimed headings "render in English in every language" / "categories are
  LOINC system classes" — both only half true; translation alone cannot fix
  either. A real fix normalizes categories at match time (map LOINC classes →
  friendly panel names; group local defs under a canonical heading), which
  changes observable extraction output and requires e2e golden regen — its
  own scoped change.

### 29. Source-language modeling: `names['ru']` doubles as the "source name" slot (deferred)

- The data model has **no persisted source language**. `BiomarkerDefinition.names['ru']`
  doubles as the slot for the name exactly as printed in the source document
  (whatever its language), `reading.original_name` carries the same per
  reading, and several consumers rely on that conflation:
  - `app/api/entries.py` resolves manually-typed rows by matching against
    `names['ru']`.
  - `app/api/flowsheet.py` falls back to `names.get("ru")` when building the
    matrix `original` column.
  - `print-editor.tsx` renders `row.original` for the `ru` output language.
- Consequence: a non-Russian document stores e.g. German text under the
  `ru` key. Everything works today because the same string is meant
  throughout, but the semantics are wrong and block honest features like
  "translate from source → X for any X" or per-document language stats.
- A real fix needs a dedicated field (e.g. `names[src]` or a
  `source_language` column + migration), matcher/serializer/entry-resolution
  updates, and backfill for existing rows. Deferred — no code changes
  planned; the user-facing label was neutralized instead ("Keep Original",
  no "(Russian)").

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