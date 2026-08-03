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
  and the user gets the unknown-editor + notes. A client disconnect mid-stream
  is also not refunded (work already ran; no DB writes in cancel paths).

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

## DB migrations

New model columns are added to existing DBs by `migrate_add_columns()` in
`app/db/session.py` (called from `init_db`; `create_all` only creates missing
tables, not missing columns).
