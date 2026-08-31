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
P0 = #37–#38; P1 = #39–#50 (backend data/security); P2 = #61–#68 (frontend
correctness); P3 = refactors/lows.

### High

**#37 [high] Matcher local-definition ids collide across users.**
`app/services/matcher/definitions.py:185` builds `local-{md5(name)[:12]}`
with no `user_id`, and the existence check (`:192-196`) and IntegrityError
recovery (`:275-280`) filter by bare id — user B extracting the same novel
analyte user A anchored gets A's definition (names/reference/canonical unit).
`entries.py:153-156` already uses `local-{user_id}-{md5}`; the matcher path
both breaks tenancy and introduces a third id scheme (duplicates vs manual
path). Fix: switch to the entries.py scheme, add ownership filters, migrate
existing rows (`^local-[0-9a-f]{12}$` with non-NULL user_id → rename + remap
`biomarker_readings.definition_id`; on collision with a same-owner def, remap
readings and delete the old row; NULL-user curated locals keep sentinel ids).
`backend/docs/architecture.md:45` pins the id format — update in the same
change.

**#38 [high] `/api/extract` never delivers the anonymous session cookie.**
`app/api/ai.py:396-398, 587-597` return `StreamingResponse` directly while
`get_current_user_or_anon` sets the anon `Set-Cookie` on the injected
`Response`; FastAPI merges dependency-set headers only when the endpoint
returns a non-`Response` value (verified against FastAPI 0.115.0). A visitor
whose first API call is `/api/extract` gets no cookie → the 5-extraction anon
limit is bypassable (each request mints a new principal) and orphaned
`UsageLimit` rows accumulate. Fix: extend the streaming response's raw headers
with the injected response's (or set the cookie in middleware). Regression
test: `Set-Cookie` present on first extract.

### Medium — backend data integrity / security

**#39 [medium] Register flow: dead migration guard, non-atomic account
creation.** `app/services/data_migration.py:185-188` —
`not UsageLimit.is_anonymous` is Python `not` on an instrumented attribute →
`WHERE 0 = 1`; the "registered usage already exists" guard never matches and a
retry would hit the PK with an IntegrityError 500. `create_user` commits
(`app/api/auth.py:186`) before `copy_anonymous_data` runs, so a failure yields
a 500 with the account already created; email check-then-insert
(`auth.py:170-174`) has a TOCTOU → unhandled IntegrityError. Fix:
`~UsageLimit.is_anonymous`, wrap register in one transaction, map
IntegrityError → 409.

**#40 [medium] IntegrityError recovery rolls back the whole session,
destroying pending work.** `app/api/entries.py:175-181`
(`_resolve_definition`, called after `save_entry` flushed the entry at
`:541-542`), `app/services/usage_limits.py:199-213` (storage path called with
`commit=False` from `_save_attachment`, `entries.py:400-402`),
`app/services/matcher/definitions.py:271-280`, `loinc_store.py:63-69`. SQLite
FK enforcement is off, so the subsequent commit succeeds with
readings/attachments pointing at a nonexistent entry (silent orphan rows), or
`spec.defn.id` raises. Fix: `begin_nested()` SAVEPOINTs (or upsert) instead of
session-wide rollback; matcher side may also discard earlier uncommitted defs
of the same batch.

**#41 [medium] Anon→registered migration drops `InstrumentalData` and
`source_language`.** `copy_anonymous_data` (`data_migration.py:38-146`) never
copies instrumental rows (model not even imported) and omits
`source_language` on the `MedicalEntry` copy — migrated instrumental tests
lose findings/conclusion; flowsheet `original_lang` and the print "original"
column are lost. Fix: copy both.

**#42 [medium] Attachment uploads are a stored-XSS vector.**
`entries.py:410-424` keeps the client-supplied extension verbatim;
`serve_upload` (`app/main.py:70-111`) serves inline with a guessed content
type and no `Content-Disposition`/`nosniff`. An uploaded `.html`/`.svg` at
same-origin `/static/uploads/…` executes JS on the API origin (anon cookie is
`SameSite=None` on HTTPS). Fix: extension allowlist, `Content-Disposition:
attachment`, `X-Content-Type-Options: nosniff`.

**#43 [medium] Definition-id lookup has no ownership filter (IDOR).**
`entries.py:105-111` resolves client-supplied `definition_id` against any row
(including another tenant's local def — the id itself leaks the owner's
user_id); same for `resolve_definitions` (`_serializers.py:130-140`) and
`_find_definition_by_id_or_loinc` (`timeline.py:331-345`); the LOINC fallback
uses nondeterministic `.first()` where the matcher ranks by `common_rank`.
Apply the same visibility predicate as the fuzzy path; make the fallback
deterministic.

**#44 [medium] Glued-unit numeric range degrades to a junk qualitative
reference → false "abnormal".** `"3.9-6.1 ммоль/л"`:
`reference.py:223-230` — `_parse_numeric_token("6.1 ммоль/л")` → None, so the
range branch is skipped and `parse_reference` returns
`{kind:"qualitative", expected:"3.9-6.1 ммоль/л"}`; `_qual_status`
(`:343-368`) then marks any numeric value "abnormal", and
`definitions.py:250` persists the junk reference on the definition. Fix: strip
known unit suffixes in the range branch; unparseable → `None` (unknown ref);
`_qual_status` returns `""` (unknown), not "abnormal", for unrecognized
expected + numeric value.

**#45 [medium] Double unit conversion can silently corrupt values (no
printed-range path).** `matcher/standardize.py:172-185` — `convert_units`
runs toward `defn.unit`, which for local defs is the anchor document's *raw*
unit (may be log-scale, e.g. `lg копий/мл`), before
`_convert_to_canonical`; a hallucinated LLM factor multiplies the value and
passes through with `needs_review=False`. Fix: skip `convert_units` when
`defn.canonical_unit` is set (keep it for legacy NULL-canonical LOINC defs);
refuse log-scale conversion targets.

**#46 [medium] Ratio anchoring only enforced for log-kind/empty units.**
`definitions.py:50-55` + `units_guess.py:146-147` — a ratio/index analyte
whose table leaks a concentration unit (`мг/дл`) anchors a concentration
canonical, so the `_convert_to_canonical` ratio pass-through
(`units_conversion.py:268-273`) never fires. Fix: run `_is_ratio_name`
before anchoring *any* unit; force `{"unit":"ratio","kind":"linear"}`.

**#47 [medium] Doc-range path skips unit-mismatch review for string values.**
`standardize.py:118` guards `_convert_to_canonical` on numeric, so with a
printed range qualitative strings never get flagged `needs_review` on unit
mismatch; the no-doc path (`:189-191`) flags the identical input. Fix: call
it for strings too (it already short-circuits absent-canonical strings).

**#48 [medium] Non-finite floats accepted; fixed-decimal rounding zeroes
trace values.** `reference.py:245-247` — `parse_value` accepts
`"nan"`/`"inf"` (NaN poisons `compute_status` → "normal", non-standard JSON);
`converters.py:241,246` — `round(v*factor, 4)` maps 0.00005 → 0.0 → false
"low". Fix: reject non-finite; round to ~6 significant digits.

**#49 [medium] Batch unit translations keyed by LLM response list order.**
`units_guess.py:278-290` — `zip(parsed.translations, needed.items())`
mis-keys the cache if the LLM reorders; prefix-dropping/empty answers are
rejected but order shifts are not. Also `needed[u]` overwritten by later
biomarkers sharing a unit; `needed.pop(u, None)` at `:235` is dead. Fix: have
the LLM echo the raw unit per item and key on that.

**#50 [medium] Latin-script non-English names are never translated.**
`translation.py:89-95` requires `not _is_ascii(b.name)`, so e.g. Spanish
`"Bilirrubina total"` with empty `standard_name_en` is skipped — contradicts
the module's own prompt example (`:70`); under-matching over-produces local
defs. Fix: include every biomarker whose effective `standard_name_en` is
empty or non-ASCII.

### Low — backend

**#51 [low] No rate limit on `POST /api/auth/login`.** `auth.py:204-220` —
brute-forcing is unthrottled while forgot-password has per-email/per-IP
throttling; reuse that pattern.

**#52 [low] Expired-token fallback detected by string comparison.**
`auth.py:138` — `e.detail != i18n.tr("auth.token_expired")` silently converts
expired tokens into anonymous sessions if either message is reworded. Use a
typed marker.

**#53 [low] Whole-file reads unbounded.** `ai.py:412` reads the full upload
before OCR with no size cap; `entries.py:395-397` reads the entire attachment
before the 20 MB check. Cap at read time.

**#54 [low] Orphaned upload files when save fails after `_save_attachment`.**
`entries.py:544-579` — a 400 on late `visit_data`/`instrumental_data`
validation rolls back DB rows but leaves the file on disk with no DB row;
`upload_cleanup` only runs on delete. Validate JSON fields before writing, or
unlink on failure.

**#55 [low] Date handling quirks.** `entries.py:71-78` — `_normalize_date`
replaces tzinfo with UTC on an already-aware datetime (clobbers real offsets);
safe today only because SQLite strips tzinfo (fragile if Postgres ever).
`save_entry` rejects future dates (`:524`) but `merge_entry` doesn't.

**#56 [low] LIKE wildcard injection in fuzzy resolution.** `entries.py:130-148`
— `name_lower` interpolated into `ilike(f'%{name_lower}%')` unescaped; a name
containing `%` matches arbitrarily (not SQL injection). Escape `%`/`_`.

**#57 [low] CSV formula injection in export.** `account.py:286-291` — cells
starting with `=`/`+`/`-` written unescaped (self-inflicted, own data).
Prefix-escape on write.

**#58 [low] Matcher LLM calls lack per-call timeouts.**
`llm_matching.py:126,226`, `translation.py:102,156`, `units_guess.py:252`,
`units_conversion.py:51,168` — inherit only the client's 300 s global (× SDK
retries); one stalled verify call stalls the SSE matching stage ~5 min. Use a
per-call timeout consistent with the OCR 90 s policy.

**#59 [low] N+1 query patterns (deferred).** `timeline.py:154-175`
(per-entry + per-biomarker readings), `:87-90/:235-238/:261-264` (lazy
`entry.attachments`), `flowsheet.py:62-68`, `entries.py:455-469`. Correct but
O(N); 2-3 queries with eager loading would do.

**#60 [low] Dead code / micro-cleanups (backend).** `_make_local_copy`
(`definitions.py:284-384`) has zero call sites and a latent log-anchor
corruption at `:351` if ever revived — delete (or align with
`verify_or_create:240`); `_R_RANGE_RE` (`reference.py:20`) unused;
`pipeline.py:256-265` `grounded` overwritten two lines later;
`pipeline.py:226-235` fires a wasted LLM verify on empty batch;
`llm_matching.py:160-173` verifier-same-loinc outcome should keep, not reject;
`units_guess.py:46-54` dead params; `loinc_store.py:109-130` re-parses the
multilingual JSON per call (memoize); facade `matcher/__init__.py:54-70`
missing `build_local_name_index`/`match_local_def` re-exports;
`name_matching.py:112-118` `_PUNCT_RE` strips only one trailing punctuation
char (`"spp.)"` → different def id) and misses typographic quotes;
`units_guess.py:290` ignores LLM `kind` (document or remove the dead
`UnitTranslation.kind` field); `data_migration.py:19` `has_anonymous_data`
used only by tests.

### Medium — frontend correctness

**#61 [medium] Delete doesn't invalidate the flowsheet cache.**
`TimelineView.tsx:81-107` only refetches `['timeline']`; `['flowsheet']`
(staleTime 5 min) keeps serving the deleted entry across navigation.
Centralize delete invalidation in `entry-settings.handleDelete` with the same
`['timeline'] + ['flowsheet'] + ['biomarker-definitions']` set add-entry uses
(`add-entry.tsx:392-396`).

**#62 [medium] Register page bypasses the api layer.**
`app/register/page.tsx:69-89` — raw `fetch`, no `Accept-Language`, and
`setError(data.detail)` on a FastAPI 422 (array) crashes React rendering —
the exact bug `extractDetail` (`api.ts:82-102`) exists to prevent. Route
through a shared helper.

**#63 [medium] Auth status stuck on `loading` after a transient failure.**
`AuthStatusProvider.tsx:46-53, 74-78` — `fetchCurrentUser` rejection leaves
the header skeleton forever (no error state, no retry; `refresh()` only from
login).

**#64 [medium] NaN reference bounds accepted and persisted.**
`reference-input.tsx:36-41` → `lib/reference.ts:153-156` — non-numeric
bounds produce `intervalReference(NaN, …)`; renders `NaN – 5`, and
`JSON.stringify({low: NaN})` → `null` silently reshapes a two-sided interval
into one-sided on save. `Number.isFinite`-guard each bound in
`buildReference`.

**#65 [medium] Superseded extraction run clobbers new run's state.**
`useExtraction.ts:127-130` — after resolve, the 1.5 s success-delay tail
(`onSuccess`, `setProgressStage`, `setUploadState('editor')`) doesn't check
`controller.signal.aborted`; a new scan started in that window gets flipped
back. Guard each post-await write (the catch path already does). Currently
hard to reach (dropzone gating) but one UI change away.

**#66 [medium] api.ts error-detail inconsistencies.** `apiGet`
(`api.ts:104-111`) discards the backend's localized `detail` while every
POST/DELETE path uses `extractDetail`; hardcoded EN `'Usage limit reached'`
fallbacks at `:291, 474, 496` (use `apiFallback('usageLimitReached')` like
`:213`); `fetchCurrentUser`/`fetchAnonId` (`:603-624`) omit `Accept-Language`.

**#67 [low] `fetchEntriesByDate` has no `{ signal }` support.**
`api.ts:138-144` — `useMergePreflight` (`useMergePreflight.ts:41-68`) creates
an AbortController it can't actually pass; stale responses are filtered but
not cancelled.

**#68 [low] Schema/type drift + selected-event ScaleNote gap.**
`types.ts:193` `MatrixRow.canonical_unit_inferred` is never sent (Pydantic
drops the kwarg at `flowsheet.py:179`) — remove; `types.ts:114-124`
`MedicalEvent` omits `source_language` which the backend sends — add.
`TimelineView.biomarkersAtDate` (`:124-166`) promotes value/date/status/
merged/original_*/reference but not `scale_function`/`needs_review`, so the
selected event's chip never renders its `ScaleNote` while all other readings
do — add both to the backend result schema and copy them.

### Low — frontend a11y

**#69 [low] Custom dialogs lack dialog semantics.**
`extraction-confirm-dialog.tsx:24-47`, `unit-conflict-dialog.tsx:36-118`,
`translation-preview-dialog.tsx:116-124` — no `role="dialog"`/`aria-modal`,
no Escape/focus-trap (translation dialog has Escape/backdrop but no role);
after a unit-conflict extraction, attaching a replacement file can stack
`ExtractionConfirmDialog` on the still-open `UnitConflictDialog`. Fix
attributes + Escape + initial focus (or Radix `AlertDialog`); prevent
stacking.

**#70 [low] Primary navigation rows are keyboard-inaccessible.**
`flowsheet-matrix.tsx:145-158` (row click → `/details` — only path to
per-biomarker details), `results-panel.tsx:366-374` (FlowRow expand),
`blood-test-details.tsx:127-135` (attachment pick) — no `role="button"`,
`tabIndex`, or key handling. Also `aria-sort` on a bare `<div>`
(`results-panel.tsx:321-324`) — needs a `columnheader` role to be exposed.

### Refactors / dedup (behavior-preserving; no doc edits required)

**#71 [low] Chart-series normalization implemented 3×.**
`BiomarkerChartInner.tsx:45-58`, `flowsheet-matrix.tsx:133-143`,
`correlation-chart.tsx:87-115` — extract `lib/chart-series.ts` (value
coercion + reference-band derivation); the custom XAxis tick renderer is also
near-verbatim duplicated (`BiomarkerChartInner.tsx:109-127` vs
`correlation-chart.tsx:642-659`).

**#72 [low] `statusText` map defined 4×, with a color drift.**
`biomarker-details.tsx:16`, `expanded-biomarker-details.tsx:15`,
`flowsheet-matrix.tsx:17` (uses `text-foreground` where siblings use
`text-status-normal` — likely unintentional), plus color pairs in
`BiomarkerChartInner`/`Sparkline`. Hoist to `lib/status-labels.ts`.

**#73 [low] `dateId` duplicated.** `print-editor.tsx:121-123` vs
`PrintEditorView.tsx:25` — shared id space with
`usePrintConfig.selectedDates`; must not drift. Export one helper.

**#74 [low] `print-editor.tsx` (768 lines) mixes concerns.** Extract the
7-language maps (`TABLE_HEADINGS`, `SOURCE_LANG_*`, `LANG_NAME`) and
date/gender helpers into a `print-document.ts` module (~130 lines out);
also extends per-language date maps (only `ru` vs US today) and a GENDER map
if document polish matters (`print-editor.tsx:61-81`).

**#75 [low] Frontend misc polish.** `unit-combobox.tsx:45` search state
stale after external value changes; hardcoded light-palette classes
(`LabResultForm.tsx:141` inferred-unit ring washes out in dark mode,
`upload-screen.tsx:213`, `translation-preview-dialog.tsx:17-21`,
`correlation-chart.tsx:135`); dead `group-hover` without `group`
(`flowsheet-matrix.tsx:179`); `DoctorVisitForm.tsx:254-271` imperative DOM +
frozen label (use the `TxField` pattern from `:52-66`);
`PrintEditorView.tsx:21-33` locale-switch effect resets column/row
selections; `entry-settings.tsx:151-159` uncleaned copy-timer;
`upload-screen.tsx:96-101` `0/0 → NaN%` progress width;
`correlation-chart.tsx:399-406` stale selected ids not pruned on refetch;
`DocumentViewer` PDF failure shows blank canvas (image path has an error
message); `layout.tsx:20-24` hardcoded EN metadata + `generator: 'v0.app'`
leftover; `saveMedicalEntry`/`mergeMedicalEntry`/`deleteEntry`
(`api.ts:464-516`) have no timeout while the extract/translate paths do;
`contentDispositionFilename` (`api.ts:551-555`) ignores RFC 5987
`filename*=`; `translateBiomarkerNames` (`:236-242`) relabels external aborts
as timeouts.

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