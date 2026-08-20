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

### 26. Category translation in print/export (deferred)

- The print/export document translates biomarker names into the target
  language, but the category/panel headings (e.g. "Complete Blood Count",
  "Lipid Panel") are **not** translated — they render in English in every
  language.
- Considered translating them (categories are LOINC system classes); removed
  from scope for now — it's not clear how translated categories would be
  useful (they are structural groupings, not patient-facing terms), and it
  would need a new persisted `category_names[lang]`-style field plus its own
  LLM batch. Leave for later; no code changes planned.

### 27. Translation stability enhancements (`POST /api/translate-biomarkers`)

All changes must keep the observable contract (`backend/docs/architecture.md`
"Biomarker name translation") identical; the golden harness doesn't cover this
endpoint — verify via `backend/tests/test_translate_biomarkers.py`.

- **Chunking**: all names go into ONE LLM call with `max_tokens=1000`
  (`app/api/ai.py`, `_translate_names_to_lang`) — a large flowsheet risks
  output truncation → malformed JSON → whole document falls back to English.
  Chunk into batches of ~40–50 names, keep successful chunks, translate only
  the missing ids on a re-run.
- **Coverage validation**: the response is trusted blindly — ids the LLM
  drops, mangles, or duplicates silently fall back to English. Validate that
  every requested id came back; retry once with only the missing ones.
- **Parse hardening + retry**: `json.loads(content)` fails on
  code-fence-wrapped or verbose output with no retry. Strip fences and retry
  once on parse/network error before falling back to English.
- **Stable id matching**: the prompt asks the LLM to "echo each id back";
  opaque def ids are easy to rewrite. Consider positional tokens
  (`name_1`, `name_2`, …) instead — matches positionally, immune to id
  mangling.
- **Rate-limit awareness**: a Mistral 429 is currently indistinguishable from
  a language failure (both → refund + English fallback). Distinguish
  transient API errors and retry with backoff instead of refunding
  immediately.
- **Cross-batch glossary consistency**: at temperature 0 a single call is
  deterministic, but a def translated later in a new batch can diverge
  stylistically. Seed the prompt with previously translated pairs as a
  glossary.

### 28. Translation user-experience enhancements (print/export)

- **Silent English fallback is invisible**: when the LLM returns nothing, the
  endpoint answers 200 with English names, so the user opens an
  untranslated document without knowing why. Compare the response against the
  requested names and surface "translation failed for N names — showing
  English" instead of toasting only on HTTP errors.
- **No progress/ETA**: the Generate button is disabled with static text for a
  5–30 s call. Show a spinner + elapsed time, or per-chunk progress
  ("Translating 23 of 87…") once chunking (#27) lands.
- **No timeout**: the fetch in `frontend/src/services/api.ts`
  (`translateBiomarkerNames`) has none — a hung Mistral request leaves the
  button stuck forever. Add a client-side timeout (~60 s) with a clear error.
- **No review step**: translations are committed and the user is pushed into
  the editor. A preview ("Verify translations → Generate") would catch wrong
  medical terms before they land in the document; alternatively, an inline
  edit affordance for per-definition translated names in the print editor.
- **Cost/status transparency**: re-generating an already-translated document
  is instant and free — a subtle "already translated" note would prevent
  users from thinking it's broken when the wait is skipped.

---

## Stashed / removed features

### 25. Navigation leave-guard during AI processes (stashed 2026-08-20)

- Feature: styled "Leave while AI is working?" confirmation when the user
  navigates back while AI extraction (add-entry) or print translation
  (print-setup) is running — blocks the browser Back button (history marker +
  `popstate` interception), reload/close (`beforeunload`), and in-app nav;
  abort-on-leave so a stale completion can't hijack navigation.
- Status: implemented and verified (189 frontend tests pass, `pnpm lint`
  clean), then removed from the working tree on request so the tree stays
  focused on the biomarker-translation feature. Fully recoverable:
  - `git stash list` → `stash@{0}` (e23d908) — snapshot of the full working
    tree (translation + leave-guard) at removal time.
  - `/tmp/leave-guard.patch` — leave-guard-only delta (13 frontend files);
    applies cleanly with `git apply` on top of the translation-only tree.
- Re-apply: `git apply /tmp/leave-guard.patch` then `pnpm test` / `pnpm lint`,
  or `git stash apply stash@{0}` for the full snapshot (conflicts if the
  translation feature has been committed by then).

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