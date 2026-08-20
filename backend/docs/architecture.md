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

## Unit canonicalization / cross-scale conversion (`app/services/matcher.py`)

- Each biomarker definition stores a canonical unit (`canonical_unit`,
  `canonical_kind` in `linear|log10|ln`, `canonical_unit_inferred` bool), set
  on the FIRST reading that creates the def (first-seen unit wins — no extra
  LLM call to pick a "better" one).
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
  kind `log10`) — do not "fix" it to linear; that was tried and reverted.
- Empty unit cells are handled per-biomarker by `_guess_unit()` (analyte/
  category heuristics, `inferred: True`), NEVER by the batch LLM translator —
  a shared empty-unit cache entry would let one extraction's guess poison
  another's.
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
- Request `{lang, names: [{id, name}]}`; response `{translations: [{id,
  name}]}` — every requested id comes back, in request order, with the
  persisted translation when one exists, else the requested (English) name.
- Definitions already carrying `names[lang]` short-circuit: no LLM call, no
  quota charge (re-generates of a translated document are free). Unresolvable
  or other-user's ids are returned untouched and never written.
- The LLM call is one batched `chat.parse` (`mistral-large-latest`,
  temperature 0) covering all unique ids; names are sanitized before sending
  (empty/whitespace-only names are skipped so the model can never invent a
  translation for one), and ids the model dropped are retried once with a
  second, smaller call. Without `MISTRAL_API_KEY` the request succeeds with
  English names and never charges quota. On LLM failure the charged quota is
  refunded (`refund_ai_extraction`) and English names are returned —
  best-effort, same refund semantics as `/api/extract`.
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
