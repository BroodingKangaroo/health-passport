# HealthPassport — Issue Log (bugs, inconsistencies, feature backlog)

Convention: when an issue is resolved, delete its entry (the git history
keeps the log traceable) — feature entries (`F<n>` below) follow the same
rule and are numbered independently of the historical bug numbers referenced
from the docs. When a fix makes a documented statement false (observable
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

## Autoresearch improvements (landed 2026-09-12; F6 documents + F15 outstanding)

Deep structural review of the extraction autoresearch loop. Core diagnosis
stands: the loop is **metric-saturated** — baseline_v5 primary 0.9940 leaves
~0.006 headroom, below the fixed ε=0.02 — so the corpus must grow into hard
territory before the objective can be re-decided with data.

**Implemented 2026-09-12 and deleted from this log per the convention above
(git history keeps the detail):**

- **F7 metric v2** — `doc_fidelity` + `extras_stable` co-metrics, `METRIC
  runs=`, non-zero `unclassified` diffs exit 2 unless `--allow-unclassified`
  (`benchmark/scoring.py`, benchmark README).
- **F8 report fingerprint** — git HEAD/dirty, resolved chat provider/model,
  OCR model/cleaner, corpus/golden hashes, `snapshot_fingerprint`,
  `metric_version` (`benchmark/report_schema.py`).
- **F9 `benchmark/compare_reports.py`** — mechanical
  KEEP|DISCARD|BROKEN|POLLUTED with fingerprint refusal, per-case/cost-
  regression flags and informational `cost_tie_break`; `--screen` formalized.
- **F10 auto-invalidating snapshot** — pinned `benchmark_seed.db` (input
  fingerprint) plus live-DB reset on every invocation, which also closes the
  cross-run definition-residue class the stale `benchmark_run.db` exhibited.
- **F11 exit-code taxonomy** — chat auth/quota raises `LLMProcessingError`
  (benchmark maps it to `BenchmarkBroken`, exit 2); the live pipeline keeps
  its fallback behavior.
- **F12 parallel runner** — child stdout/stderr via temp files (no PIPE
  backpressure) and artifact cleanup on success and fail-fast paths.
- **F13 deterministic offline guard** — own pinned seed + throwaway work DBs,
  full golden warm-up, threshold unified at 0.9; absolute baseline is 5 diffs
  / 2 failing cases (`гастроэнтеролог` visit-replay trio plus the
  `колонофлор_16_25.06` ratio row), identical across runs.
- **F14 resume protocol + state schema v2** — merged-branch/`main` drift
  detection, forced re-baseline on scope drift, append-only `history`, guard
  counts, archive rotation (`.autoresearch/archive-2026-09-12/`).

---

## Autoresearch not implemented (highlighted)

### F6 (remaining). Corpus expansion: hard-case documents + validation split

**Already landed (infrastructure only — the corpus itself did NOT grow):**
`corpus/manifest.json` hashing/provenance, `--manifest` / `--split` /
`--allow-corpus-drift`, drift hard-fail, malformed-case hard error, corpus
mode in `.opencode/command/autoresearch.md` + the SKILL.md governance section,
and seed/snapshot auto-invalidation. The 9 seeded cases are all
`split: tuning` (every one was targeted before 2026-09-12).

**Outstanding — human-reviewed activity, NOT a loop iteration:**
- Add 8–12 hand-verified cases targeting known weaknesses: time-of-collection
  documents (the documented time-drop), handwritten/photographed reports,
  multi-page PDFs with split tables, instrumental free-text findings, rare/
  ratio/qualitative analytes, mixed RU/EN documents, reference ranges in
  footnotes.
- Populate the **validation hold-out** (~30% of the grown corpus): assign
  `split: validation` in the manifest BEFORE those cases are ever screened.
- Per-case acceptance: `--runs 1 --cases <new>` clean (pollution 0),
  matcher-only deterministic on the guard DB, golden hand-verified via the
  `e2e-golden` workflow, expected metric range recorded in the manifest entry.

**Deps**: none — F7 (metric v2) has landed and measures the time/clinic-heavy
cases once they exist.

### F15. Objective redesign (NOT IMPLEMENTED — deferred until F6 restores headroom)

**Status**: deferred by design; do not start until the grown corpus restores
headroom above ε.

**Why**: with ~0.006 headroom, ε=0.02 is unreachable; cost wins are discarded
by the tie rule even though cost is where the real gains came from (v5: −19%/−15%
tokens, wall 320→174 s at flat primary).

**Change (decide with baseline_v6 data)**:
- Noise-aware keep rule: bootstrap/CI from per-run recognition, and/or relative
  ε scaled to remaining headroom.
- Cost-aware keep path: quality non-inferior within CI + token/wall improvement
  ≥ X% ⇒ keep.
- Per-case non-regression gate so a single improved case cannot mask a
  regression elsewhere.

**Docs**: SKILL.md keep rule; README metric semantics.
**Deps**: F6 (documents), F7, F9 (both landed).

---

## Feature batch "Account & Data" (shipped 2026-08-31)

The 2026-08-31 product analysis identified four user-facing gaps: no
export/backup path for the structured data, invisible usage limits (only
reactive 429 toasts), and no account self-service. All five planned features
(F1–F5) were implemented in one batch and their entries deleted per the
convention above — the shipped contracts are documented in
`backend/docs/architecture.md` (export endpoint, change-password,
account deletion, shared `upload_cleanup.unlink_unreferenced_files`) and
`frontend/docs/architecture.md` (Settings page: profile, usage meters,
data-export card, danger zone).

### Candidate future features (not scheduled)

- **Quota model revamp**: lifetime counters → rolling/monthly reset (public
  deployment); surface remaining quota near the upload flow (currently only
  the settings usage card + reactive 429s).
- **One-click PDF download** of the passport document (the print flow
  currently ends in `window.print()`, `print-editor.tsx:615-623`).
- **Backup restore/import** to complement `GET /api/export`.

---

## Audit 2026-08-31 — principal-engineer review (full stack)

Findings verified against the current working tree (HEAD `8c0a969`) by four
parallel deep-dive reviews (backend API/DB, matcher package, frontend data
layer, frontend components); top findings re-verified manually. Line numbers
refer to files as they stand now. Severity in brackets. Plan of record:
P1 = #39–#50 (backend data/security); P2 = #61–#68 (frontend correctness);
P3 = refactors/lows.

All findings from this audit were resolved and committed between
2026-09-01 and 2026-09-02 (one commit per issue, regression tests per fix;
docs updated where a documented statement changed):

- **#39–#50** backend data/security (atomic register + SAVEPOINT
  IntegrityError recovery, definition-id IDOR filters, double-conversion +
  ratio-anchor + doc-range-string + echo-keyed batch translator + Latin-name
  translation fixes)
- **#51–#58, #60** backend lows (login throttle, typed token-expiry marker,
  capped file reads, no orphaned uploads, date handling, LIKE escaping,
  per-call LLM timeouts, dead-code sweep)
- **#59** N+1 query patterns (batched/eager fetches in timeline, flowsheet,
  and by-date endpoints, pinned by query-count bounds)
- **#62–#70** frontend correctness + a11y (register via api layer, auth
  recovery, NaN reference bounds, extraction abort guards, localized api
  errors, abortable preflight, schema/type drift, dialog semantics, keyboard
  nav)
- **#71–#75** refactors + polish (chart-series/status/dateId dedup,
  print-document module, misc UI + api robustness)

### Verified working (this audit — do not re-check)

- lg↔linear invariant end-to-end (`_linearized_anchor`, reference/value
  rescale, `10^x`/`exp` scale functions, batch-translator prefix-drop
  rejection, migration script) — pinned by `test_lg_anchor.py`
- `/api/extract` persistence invariant: `_match_in_thread` own
  `SessionLocal()`, commit-before-close, rollback-on-error, expunge-before-
  thread (`ai.py:438-442, 539-551`)
- Tenant scoping on timeline/flowsheet/export/merge queries; delete flows
  (snapshot-then-unlink, single conditional UPDATE storage decrement)
- SSE quota charge/refund paths (abort, failure, empty-result refunds;
  conditional-UPDATE increments)
- Merged-readings contract: `MergedSectionHeader` only in results-panel;
  flowsheet/print exclusion; `biomarkersAtDate` isLatest gating (test-pinned)
- Inferred-unit blue ring confined to `LabResultForm`; no `InferredUnitNote`
  anywhere
- Frontend i18n: cookie-only locale, no URL routing, catalog parity test,
  `Accept-Language` on main paths; proxy rewrites intact (no client base
  URLs); SSE parser + 90 s watchdog; anon cookie HMAC + `compare_digest`;
  `serve_upload` path-traversal guard; password reset (hashed single-use
  tokens, no enumeration); Pearson/t-p stats math; `sortReadingsByDate` as
  single chart choke point
- Suites green at audit time: backend pytest, frontend vitest (333),
  both lints

---

## Verified working (2026-08-02 audit, explicit checks)

- Auth round-trip (JWT ⇄ NextAuth), anonymous-session id, `fetchAuthedObjectUrl` /
  `printAuthedDocument` for protected uploads, per-user file authorization in
  `app/main.py:57`
- Delete entry + usage counter refund; same-date merge feature & merged-readings
  sections in timeline only
- Unit-conversion dialog + flowsheet `ScaleNote` (cross-scale log↔linear); the
  merged/biomarkers-at-date flag handling (`TimelineView.biomarkersAtDate`)
- LOINC reference model (interval/qualitative), compact number formatting,
  reference editor, registration + DOB validation

