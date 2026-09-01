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
- **#62–#70** frontend correctness + a11y (register via api layer, auth
  recovery, NaN reference bounds, extraction abort guards, localized api
  errors, abortable preflight, schema/type drift, dialog semantics, keyboard
  nav)
- **#71–#75** refactors + polish (chart-series/status/dateId dedup,
  print-document module, misc UI + api robustness)

### Deferred

**#59 [low] N+1 query patterns (deferred).** `timeline.py:154-175`
(per-entry + per-biomarker readings), `:87-90/:235-238/:261-264` (lazy
`entry.attachments`), `flowsheet.py:62-68`, `entries.py:455-469`. Correct but
O(N); 2-3 queries with eager loading would do.

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