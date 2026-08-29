# Backend architecture (HealthPassport)

On-demand companion to AGENTS.md — read this file before touching matcher
code, `/api/extract`, entry persistence, merge/delete, or DB migrations.

## Stack & running

- Python 3.9, pip into local `venv/` (already present). Install:
  `pip install -r requirements.txt`.
- Run API: `uvicorn app.main:app --port 8000` (from `backend/`, venv active).
  `main.py` calls `load_dotenv()` and `init_db()` on startup.
- **DB env**: defaults to `sqlite:///./health_passport.db`. Override with
  `DATABASE_URL`. Tests use an in-memory sqlite via `tests/conftest.py`
  (auto-created/seeded per test; no DB setup needed).
- **Required env**: `MISTRAL_API_KEY` (in `.env`) — needed for
  OCR/extraction/matching in `ai.py`. `.env` and `.jwt_secret` are committed
  here (dev-only secrets; not production-safe).
- **Chat model knob**: all chat LLM calls (extraction, translation, matcher
  helpers) use `config.MISTRAL_CHAT_MODEL` (env `MISTRAL_CHAT_MODEL`,
  default `mistral-medium-latest` since 2026-08-29 — the tier dropped
  `mistral-large-latest` with 403 `tier_not_allowed`). OCR always uses the
  Mistral OCR endpoint and ignores this knob. The OpenRouter failover
  (`CHAT_FAILOVER=openrouter`) fires on chat errors regardless of the model.
- Tests: `python -m pytest tests/ -v`. `pytest.ini` sets `asyncio_mode =
  auto`; `pytest-asyncio` + `httpx` are used. The test `client` fixture builds
  its own FastAPI app with dependency overrides — it does NOT test `main.py`
  wiring or the `/static/uploads` route.
- Lint: `venv/bin/ruff check .` — config in `backend/pyproject.toml`
  (`target-version py39`; `B008`/`BLE001`/`RUF001-3`/`ASYNC230`/`ASYNC240`/
  `PERF203` ignored as intentional). Keep the tree lint-clean before
  committing.
- `app.log` is written at runtime (logging in `main.py`); generated artifact,
  not source.

## Seeder & LOINC dictionary

- **One seeder**: `python -m app.db.seed_loinc` **drops and recreates the DB**,
  then seeds `biomarker_definitions` from `data/Loinc.csv` (lab-relevant
  classes, common-ranked) and applies curated reference ranges.
- The LOINC dictionary is the **single source of truth** for biomarker
  definitions — no separate baseline/seed module. `init_db` only creates
  tables.
- Ungrounded biomarkers extracted from a document are created dynamically as
  `scope=local` definitions at extraction time (id
  `local-{md5(name)[:12]}`), never pre-seeded.
- Seeding also writes `data/loinc_aliases.json` (folded-code → survivor-code
  map from the dedupe step). It is **committed** and load-bearing: the
  matcher's curated-code redirect (`matcher/loinc_store.py`) silently degrades
  without it (folded codes get promoted as duplicate globals). The file is
  deterministic from the tracked inputs — recomputed aliases always match.
- Run `seed_loinc` once (required for realistic `/api/extract` and e2e). Keep
  the dictionary stable while a golden is in use or mappings drift.

## Reference model

Replaces the old `range_min`/`range_max` + qualitative-flag model:

- Every biomarker definition and reading carries a single structured
  `reference` JSON column whose `kind` IS the result type:
  - `{kind:'interval', low, high}` — numeric results
  - `{kind:'qualitative', expected}` — text results (e.g. "Negative")
- There is **no separate `result_type`**; the kind is the sole discriminator.
- `status` is `low|normal|high` for interval results, `normal|abnormal` for
  qualitative (mismatch), **computed at save time by
  `app/services/reference.py` (`compute_status`) and persisted** to
  `biomarker_readings.status` — it is NOT recomputed on read; serializers
  serve the stored column.
- Readings store `value` (Float, nullable) for numbers and `value_text`
  (String, nullable) for qualitative text, merged into one union `value` on
  the wire.

## Anonymous session principal (auth)

- The anonymous identity is carried in the `healthpassport_anon_id` cookie as an
  **HMAC-SHA256-signed** value (`{anon_id}.{signature}`), signed with the same
  `SECRET_KEY` as JWTs (`app/auth.py`). `verify_anon_cookie` (`app/api/
  anon_session.py`) rejects unsigned, tampered, or non-`anon-`-prefixed values;
  `get_current_user_or_anon` then treats that request as a fresh session.
- The raw cookie is **never** trusted as the authorization principal: forging it
  to another tenant's id (registered uuid or another anon id) yields a brand-new
  session, never the victim's data. A hard cutover — legacy unsigned cookies are
  unconditionally rejected — means data behind existing pre-fix anon cookies is
  orphaned.
- Registration-time data migration (`/api/auth/register` `migrate_data`) only
  reads the anon id through `verify_anon_cookie`, so a forged/legacy cookie can
  never copy another user's data into the new account.
- **Wire contract**: `BiomarkerDefinition` / `BiomarkerDefinitionResponse`
  (and therefore every timeline/flowsheet/detail `definition` object) do **not**
  expose `user_id`. Definitions are serialized through `definition_schema` in
  `app/api/_serializers.py`; the owner id stays server-side so def lookups can
  never leak a tenant id into a client's matrix.

## Matcher package layout (`app/services/matcher/`)

The former single-module `matcher.py` is split into focused submodules behind
a re-exporting facade (`app/services/matcher/__init__.py`). External code
(`ai.py`, `e2e/validate_offline.py`, tests) keeps importing from
`app.services.matcher`; only the facade knows about the split. Submodules
import each other directly (never via the facade) so `@patch` targets keep
working.

| Module | Purpose |
|---|---|
| `_cache.py` | Per-thread, extraction-scoped LLM caches (`_RequestBucket` + factor/unit/scale-function caches as shared singletons) |
| `_text.py` | Tiny shared text helpers (`_is_ascii`) |
| `loinc_store.py` | LOINC CSV loading, `_promote_loinc_from_csv`, alias + multilingual lookup tables |
| `name_matching.py` | Name index build, deterministic/fuzzy matching, grounding check, percent→fraction routing |
| `llm_matching.py` | Candidate retrieval, zero-shot LOINC guess batch, verification backstop |
| `units_guess.py` | Unit translation to English + `_guess_unit()` empty-unit heuristics |
| `units_conversion.py` | Conversion factors (`convert_units`), cross-scale functions, canonical-unit landing |
| `translation.py` | Biomarker-name + visit-data LLM translation with fallbacks, date/time normalize |
| `definitions.py` | `verify_or_create` / `_make_local_copy` — definition resolution & persistence (first-seen canonical units anchor here) |
| `standardize.py` | `StandardizedBiomarker` builders, status apply, LLM-free fallback path |
| `pipeline.py` | The `match_and_convert` orchestrator |

## Backend module map (previously-undocumented modules)

Reference for agents so these aren't re-derived via grep each session:

| Module | Purpose |
|---|---|
| `app/db/models.py` | SQLAlchemy ORM models: `Patient`, `BiomarkerDefinition`, `BiomarkerReading`, `MedicalEntry`, `VisitData`, `InstrumentalData`, `Attachment`, `UsageLimit`, `CategoryTranslationCache`, `PasswordResetToken`, etc. |
| `app/db/import_ranges.py` | Curated common reference ranges (`COMMON_RANGES`) merged into existing global definitions; run via `python -m app.db.import_ranges`. |
| `app/services/extractor.py` | Pass-1 OCR→LLM raw extraction: turns document text into a `RawMedicalRecord` (raw biomarkers / visit / instrumental data) before the matcher runs. OCR markdown is deterministically de-boilerplated before any LLM call (`_clean_ocr_markdown`: separator rows, page furniture, keep-first dedupe of repeated non-tabular lines; `OCR_MARKDOWN_CLEAN=0` disables — the benchmark's A/B switch). |
| `app/services/chat_client.py` | Env-gated chat-provider split (`CHAT_PROVIDER=openrouter` + `OPENROUTER_API_KEY`): wraps the Mistral client so `.chat.parse` goes to an OpenAI-compatible provider (pydantic → json_schema with prompt-side schema hint; validates replies and retries; multi-model fallback via `OPENROUTER_CHAT_FALLBACKS`) while `files`/`ocr` stay Mistral. `OPENROUTER_SCOPE=extraction` routes only the extraction call there; `CHAT_FAILOVER=openrouter` retries a Mistral chat call that failed post-SDK-retry on the OpenRouter route (counted as `chat_failover_events()`; the benchmark prints `METRIC chat_failovers` so mixed-provider weather stays visible). Default (`mistral`) is unchanged behavior. |
| `app/services/converters.py` | Hybrid value unit conversion (identity → dimensional via `pint` → molar/mass via per-analyte molecular weight → LLM-supplied factor fallback). |
| `app/services/data_migration.py` | Anonymous→registered account data migration (read-only through `verify_anon_cookie`, so a forged/legacy cookie can't copy another tenant's data). |
| `app/services/category_normalize.py` | `normalize_category()` — maps raw LOINC `CLASS` codes, per-LOINC overrides, curated local sentinel codes and known source headings to friendly panel names (see below). |
| `app/api/anon_session.py` | Anonymous-session cookie issue/verify (`get_or_create_anon_id`, `verify_anon_cookie`); HMAC-signed, never trusted raw. |

## Category normalization (extraction output)

- Global (LOINC-matched) definitions used to carry the raw LOINC `CLASS` code
  as their `category` (e.g. `"HEM/BC"`, `"CHEM"`), which renders as a cryptic
  heading even on English documents. `app/services/category_normalize.py`
  normalizes the stored `category` at definition-creation time in both the
  seeder (`seed_loinc.row_to_definition`) and the matcher
  (`matcher/definitions.py`):
  - per-LOINC-code panel overrides refine coarse classes (e.g. `CLASS=CHEM`
    for ALT → `"Liver Function"`, Glucose → `"Comprehensive Metabolic Panel"`,
    Cholesterol → `"Lipid Panel"`);
  - unambiguous `CLASS` codes map directly (`"HEM/BC"` → `"Complete Blood Count"`,
    `"CELLMARK"` → `"Immunology"`);
  - curated local sentinel codes (the `local-…` ids from
    `data/multilingual_synonyms.json`, e.g. `local-opisthorchis-igg`) are pinned
    to their analyte family's panel via `LOCAL_PANEL_BY_CODE` — the pipeline
    forwards the sentinel code into the local-definition creation, so a
    deliberately-local analyte lands in the same panel as its global siblings;
  - known source-document headings (any language, lowercased lookup in
    `SOURCE_HEADING_TO_PANEL` — e.g. `"Инфекции"` → `Microbiology`,
    microbiome panel headings → `Microbiome`) resolve deterministically;
    unknown headings are kept verbatim (whitespace-collapsed).
- The e2e `compare.py` does **not** compare `category`, so this change does not
  affect the golden harness, but the stored `category` values in
  `e2e/golden/*/standardized.json` were updated to the normalized form.

## Unit canonicalization / cross-scale conversion (`matcher/units_conversion.py`, `matcher/units_guess.py`)

- Each biomarker definition stores a canonical unit (`canonical_unit`,
  `canonical_kind` in `linear|log10|ln`, `canonical_unit_inferred` bool), set
  on the FIRST reading that creates the def (first-seen unit wins — no extra
  LLM call to pick a "better" one). Log-scale translations are linearized at
  anchor time (see below), so a freshly anchored def is always `linear`
  (or unitless/ratio); `log10|ln` kinds only survive on defs anchored before
  that rule (migrated by `scripts/migrate_lg_to_linear.py`).
- Every later reading of the same biomarker whose unit differs is converted
  into the canonical unit via a `scale_function` (`"10^x"`, `"log10"`,
  `"exp(x)"`, `"ln"`, `"factor:<N>"`), stored per-reading with `needs_review`
  (`true` when conversion failed/kept raw).
- Both the **value AND the interval reference bounds** are converted with the
  same scale function so status stays correct.
- Pure log↔linear changes are deterministic in `_llm_scale_function` (NO LLM
  call); the LLM is only consulted for same-kind `factor:<N>` conversions.
- `_apply_scale_function` keeps an absent/below-detection value of `0.0` at
  `0.0` for `10^x`/`exp(x)` (never `10^0 = 1`).
- Russian unit prefix **`lg` MEANS log10** (`"lg копий/мл"` → `lg copies/mL`,
  kind `log10`) — values are NEVER treated as linear numbers. Since 2026-08-29
  the canonical unit itself always lands on the LINEAR magnitude
  (`definitions.py _linearized_anchor`): `lg копий/мл` anchors canonical
  `copies/mL`, the anchoring document's own value/reference bounds are scaled
  10^x at creation, and readings printed in the log unit convert via the
  deterministic `10^x` scale function. Ratio-like analytes (ratio / index /
  соотношение names) are dimensionless — a log prefix on their unit column is
  a table-header artifact, so they anchor `ratio` and never scale.
  Canonical absent strings (`Not detected`, …) against a foreign canonical
  unit don't set `needs_review` (no quantity to convert), and a unitless
  (qualitative) def never leaks a raw unit column onto its readings.
- Empty unit cells are handled per-biomarker by `_guess_unit()` (analyte/
  category heuristics, `inferred: True`), NEVER by the batch LLM translator —
  a shared empty-unit cache entry would let one extraction's guess poison
  another's.
- **Cross-document local unification** (2026-08-29, `name_matching.py
  build_local_name_index` + `match_local_def`, pipeline step 1d2): the user's
  OWN local definitions are match candidates. The same analyte worded
  differently by different labs (соотношение/отношение, "… ratio" vs
  "Ratio of … to …", «динамика» suffixes — stripped before matching) resolves
  to the first-seen local def instead of spawning a duplicate. Guards:
  WRatio ≥ 78 + plain-ratio ≥ 55 + token-subset rejection (a query strictly
  contained in the candidate's tokens never merges) + carrier-collision
  guard + a measurement-KIND gate (unitless qualitative defs never absorb
  numeric rows and vice versa). Local matches are trusted (no LLM
  verification backstop). Globals always win collisions; def ids/EN names
  stay first-seen (which document processed first decides the merged def's
  identity — harness/benchmark replay order mirrors the suite's
  alphabetical order).
- Surface on the wire: `standard_unit`, `scale_function`, `needs_review`,
  `canonical_unit_inferred`.

## AI extraction quota (`/api/extract`)

- The extraction-count increment is committed (`db.commit()`) once the file
  passes validation — before OCR/LLM run — so concurrent requests can't both
  slip past the limit while a multi-second extraction is in flight.
- A document whose OCR/extraction then FAILS (OCR error, empty OCR text, LLM
  error, matcher error) gets its charged extraction refunded by
  `refund_ai_extraction()` (`app/services/usage_limits.py`) before the error
  SSE event is sent. File-validation failures (400) never burn quota at all.
- An `entry_type: "unknown"` result is NOT refunded — the LLM genuinely ran
  and the user gets the unknown-editor + notes.
- A client disconnect mid-stream (`asyncio.CancelledError` / `GeneratorExit`)
  IS refunded: the SSE stream never delivered a result event, so the user
  shouldn't pay for an extraction they didn't get. The refund is best-effort
  via `_refund_on_abort` (`app/api/ai.py`) — it never raises and the original
  cancellation always propagates.
- During the long silent OCR/LLM/matching phases the SSE stream emits
  `: keep-alive` comment lines every 15s (ignored by SSE clients and the e2e
  harness) so a healthy-but-slow extraction isn't mistaken for a dead one.

## Biomarker name translation (`POST /api/translate-biomarkers`)

- Translates the English names of biomarker definitions into a target language
  (`de`|`fr`|`es`|`he`|`pl`) and persists each translation into the definition's
  `names[lang]` JSON column, so every later render (flowsheet, print editor)
  reads it without another LLM call. `en`/`ru` are not targets: `en` names
  already exist and `ru` prints the source name directly.
- Request `{lang, names: [{id, name}], categories?: [str], persist?}`; response
  `{translations: [{id, name, source}], categories: [{original, translated,
  source}]}` — every requested id comes back, in request order,
  with the persisted translation when one exists, else the requested
  (English) name. Each item's `source` classifies how `name` was produced:
  `translated` (newly LLM-translated this request), `cached` (the definition
  already carried `names[lang]`), or `fallback` (LLM failure/drop,
  unresolvable or foreign id, or empty name) — so clients can surface silent
  English fallbacks instead of trusting every response blindly.
- **Category/panel headings** (`categories`) ride the same LLM batch under
  synthetic `category:<md5>` ids (deduped after whitespace-sanitization;
  empties skipped) and are never written to the definitions — they come back
  keyed by their exact input string (first-seen spelling wins for sanitized
  duplicates) with `source` only ever `translated`/`fallback`. A
  category-only request is valid; cached names plus new categories still
  reach the LLM.
- **Heading cache**: fresh heading translations land in a shared
  `category_translation_cache` table (all users, keyed
  `{lang}:{sha256(cleaned heading)}`, `original` kept for readability).
  Lookups run before the LLM batch — only misses are sent — and results are
  written in the same commit as the name persistence. **The shared cache is
  populated only by authenticated principals** — anonymous requests still
  receive heading translations in the response but never write into the shared
  cache, so an anonymous caller cannot seed poisoned headings that every user's
  print render then trusts (ISSUES.md #33). There is no
  invalidation: headings are generic static lab terminology and translations
  run at temperature 0. Cached translations also seed the prompt glossary so
  fresh ones match their style. **Quota is charged only when actual LLM work
  exists** — a fully-cached request (all names persisted, all headings
  cached) returns instantly and free; on total LLM failure the quota is
  refunded but cached headings are still returned.
- **Two-phase review flow**: with `persist: false` the translations are
  returned but NOT written — the print-setup review dialog lets the user
  accept/reject each term and then commits only the accepted ones via
  `POST /api/translate-biomarkers/commit` (`{lang, items: [{id, name}]}` →
  `{saved: n}`). The commit endpoint writes names verbatim into visible
  definitions' `names[lang]`: no LLM call, no quota charge (the LLM already
  ran in the phase-1 request; its quota increment is committed either way).
  Unresolvable/foreign ids are skipped by both endpoints. Default is
  `persist: true` (translate-and-save in one shot).
- **Writes require authentication** (ISSUES.md #32): persisting translations
  (`persist: true` on `/api/translate-biomarkers` and the `/commit` endpoint)
  only writes when the caller is an authenticated principal. Anonymous requests
  still receive the translated names/headings in the **response** (so the
  review UI works) but the writes are skipped — an anonymous caller can never
  rewrite a shared (global/system) definition's `names[lang]`, nor can they
  supply unbounded-length strings (`CommitTranslationItem.name` /
  `BiomarkerNameItem.name` and `TranslateRequest.categories` are length- and
  count-capped in `schemas/ai.py`). `/commit` returns `403` for anonymous.
- Definitions already carrying `names[lang]` short-circuit: no LLM call, no
  quota charge (re-generates of a translated document are free). Unresolvable
  or other-user's ids are returned untouched and never written.
- Translation runs in chunked `chat.parse` calls (`mistral-large-latest`,
  temperature 0), at most 45 unique ids per call (`TRANSLATE_CHUNK_SIZE`),
  each bounded by `TRANSLATE_MAX_TOKENS` so a large flowsheet cannot truncate
  into a silent English fallback. Names are sanitized before sending
  (empty/whitespace-only names are skipped so the model can never invent a
  translation for one). Items are identified to the model by positional
  tokens (`t1..tN`, restarting per chunk) and mapped back to the real ids
  server-side — immune to the model mangling opaque def ids. A known token
  answered with an empty string keeps the input name (kept-as-is), and the
  prompt explicitly forbids omitting items whose name stays unchanged —
  Latin terms/acronyms were previously dropped by the model into false
  English fallbacks. Ids the model drops are retried once with a smaller
  call; a response that fails to parse (truncation, code fences) is retried
  once; ids still missing after all chunks get final smaller straggler calls
  (`TRANSLATE_STRAGGLER_CHUNK_SIZE`, with their own drop-retry) — every
  extra call is spent before an id is allowed to fall back to English, and
  anything that still falls back is logged as a warning. A
  glossary of already-persisted translations seeds every prompt so later batches stay stylistically
  consistent. A sustained Mistral 429 (one that surfaces even after the
  client's own retry/backoff config) aborts the remaining chunks instead of
  stacking more doomed calls: earlier chunks keep their translations, the
  rest fall back to English, and quota is NOT refunded when anything
  translated (partial success is persisted). Without `MISTRAL_API_KEY` the
  request succeeds with English names and never charges quota. On total LLM
  failure the charged quota is refunded (`refund_ai_extraction`) and English
  names are returned — best-effort, same refund semantics as `/api/extract`.
- Translations are quota-gated like extractions
  (`check_and_record_ai_usage`): a 429 is raised when the shared AI counter is
  exhausted, so repeated translation of a large dictionary cannot silently
  burn the user's quota.

## Extraction output contract

- Blood-test `date` prefers the biomaterial **collection date** when shown;
  only falls back to the report/results date otherwise. `time` is emitted only
  when a time appears next to that same date.
- Instrumental reports: `modality` must be exactly one of the fixed list
  `MRI, CT, X-Ray, Ultrasound, Elastography, Mammography, PET Scan, ECG,
  Endoscopy, Other` (mirrors the frontend `MODALITIES`); content goes to
  `findings`/`conclusion`; `notes` stays empty (no duplication).

## CRITICAL — `/api/extract` persists definitions

Matching runs in a worker thread (`backend/app/api/ai.py`,
`_match_in_thread`) using its own `SessionLocal()`. It MUST `commit()` before
`close()` (and `rollback()` on error). Without the commit, definitions created
by `verify_or_create` (and their canonical units) are silently lost, so every
subsequent extraction re-creates them fresh and cross-document unit
conversion never engages. This is the #1 thing to check if sequential
extractions "forget" units.

## DELETE /api/entry/{entry_id} (`app/api/entries.py`)

- Hard-deletes a single entry. Cascades via ORM `delete-orphan` (readings,
  visit_data, attachments).
- Unlinks uploaded files from disk only when no other `Attachment` row still
  references the same path — so the anon→user migration case (which
  duplicates the attachment row, see `auth.py:168`) is safe and never unlinks
  a still-shared file.
- Storage quota is refunded by a single conditional `UPDATE UsageLimit` so
  concurrent deletes cannot drive the counter negative.
- Scoped to `user_id`; unknown or other-user's ids return 404 (no info leak).
- Schema: `DeleteEntryResponse` in `app/schemas/common.py`.

## Entry types & `instrumental_data`

- `save_entry` accepts four entry types: `blood_test`, `doctor_visit`,
  `instrumental_test`, `procedure`. `/api/extract` classifies documents as
  `blood_test` | `doctor_visit` | `instrumental_test` | `unknown`.
- Biomarker readings are persisted **only** for `blood_test` entries — the
  server ignores a `biomarkers` field sent with any other type (stale
  extraction leftovers would otherwise create invisible definitions and
  pollute matching).
- `instrumental_test` entries carry an `instrumental_data` JSON payload
  (`{modality, findings, conclusion}`) saved to the `instrumental_data` table
  (1:1 with `medical_entries`, delete-orphan cascade) — the same pattern as
  `visit_data`.
- `GET /api/timeline` returns the payloads in an `instrumental: {entry_id:
  {modality, findings, conclusion}}` map (same pattern as `visits`); reading
  serialization stays blood-test-only.

## Merge same-date blood tests (`POST /api/entry/{id}/merge`)

- Folds a later blood-test upload into an existing entry — new biomarker
  readings (marked `merged=True`), appended notes, and the uploaded document
  attached; the target's own metadata (date/time/title/clinic/provider) is
  untouched.
- Refuses with 409 when any resolved definition already has a reading in the
  target (by definition id OR LOINC code) and rolls back atomically, including
  newly created definitions.
- Merged readings carry a `merged_source` JSON snapshot
  `{title, clinic, provider, time}` (non-empty fields only; blank title falls
  back to the uploaded document's filename sans extension) so the UI can
  describe the second test.
- Shared helpers `_ReadingSpec`/`_resolve_definition`/`_parse_biomarker_rows`
  keep `save_entry` and merge in lockstep.
- `GET /api/entries/by-date` returns per-biomarker `names`+`synonyms` so
  clients can mirror the server's name-based resolution for manually-typed
  rows.

## Timeline / flowsheet ordering and entry ids

- Blood-test queries order by `(date, created_at, id)` — never `date` alone —
  so same-day tests have a deterministic order (and the timeline's default
  selection and the flowsheet "(Latest)" badge are stable). `created_at` is
  preserved by the anon→user migration; ties within one second fall back to
  the (arbitrary but stable) id.
- Every `Reading` (history entry) and `BiomarkerResult` (top-level latest
  reading) carries `entry_id` — the medical entry the reading belongs to — so
  clients match readings to events unambiguously when several tests share a
  date. All serialization flows through `reading_schema`/`result_schema` in
  `app/api/_serializers.py`.
- Flowsheet composite ids look like `{biomarker_id}-{month}-{day}`
  (`short_date_label` lowercased, e.g. `713-8-may-26`); when several tests
  share that label (same month/day across years too), the FIRST keeps the
  plain id and repeats get `-{n}` (`wbc-oct-15-2`). `/api/biomarker/{id}`
  strips the suffix via `_FLOW_SHEET_LABEL_RE`
  (`-(?:month)-\d{1,2}(?:-\d+)?$`) before resolving.
- Flowsheet date headers disambiguate identical columns only: a `(#n)` suffix
  is added per colliding `(label, time-sub)` pair, never blanket-applied to a
  whole day (tests with distinct times stay plain, tests with the same time —
  or no time — get numbered).

## Auth & password reset (`/api/auth`)

- Registration/login are credentials-based; the frontend proxies them through
  NextAuth (`/api/auth/register`, `/api/auth/login`). Passwords are bcrypt
  hashed (`app/auth.py`) and must be ≥ 8 chars (enforced on the backend for
  both register and reset). JWTs are signed with `SECRET_KEY`/`.jwt_secret`.
- Password recovery: `POST /api/auth/forgot-password {email}` and
  `POST /api/auth/reset-password {token, new_password}`.
  - `forgot-password` always returns 200 with the same body whether or not the
    email exists (no user enumeration; a mailer failure is logged and also
    returns 200). If the user exists it stores a 30-minute, single-use token —
    only its SHA-256 hash is persisted in the `password_reset_tokens` table
    (`token_hash`, `patient_id`, `expires_at`, `used_at`) — and emails the raw
    token via `app/services/mailer.py` (sent off the event loop). Expired and
    used tokens are purged on each request. The emailed link always uses the
    configured `FRONTEND_URL` (default `http://localhost:3000`) — request
    Origin/Referer headers are never trusted, since a direct API caller could
    otherwise rewrite the link to a phishing domain holding a valid token. In
    local dev (`SMTP_ENABLED` unset, the default) the reset link is logged
    instead of emailed. Endpoint is rate-limited in-memory (5/hour per email,
    20/hour per IP).
  - `reset-password` validates the token (exists, unused, unexpired), enforces
    a min 8-char password, replaces `patients.hashed_password`, and marks the
    token used (replay → 400). Existing JWT sessions stay valid until their
    normal expiry; the new password takes effect on the next login.

## DB migrations

New model columns are added to existing DBs by `migrate_add_columns()` in
`app/db/session.py` (called from `init_db`; `create_all` only creates missing
tables, not missing columns).
