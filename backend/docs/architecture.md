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
  OCR/extraction/matching in `ai.py`. `.env` and `.jwt_secret` are
  **gitignored** (dev-only secrets; not production-safe) — `backend/.env.example`
  documents the expected keys, including the mail/URL ones below.
- **Mail env** (`.env.example` has the full list): `FRONTEND_URL` is the base
  of every link in outgoing email; `SMTP_ENABLED` + `SMTP_HOST/PORT/USER/
  PASSWORD/FROM` configure the transport, and `SMTP_SECURITY=
  starttls|ssl|none` selects it (`ssl` = implicit TLS via `smtplib.SMTP_SSL`
  for providers that require port 465; the legacy `SMTP_TLS` flag still works
  when `SMTP_SECURITY` is unset — true → starttls, false → none). Credentials
  over an unencrypted connection are REFUSED unless the operator explicitly
  sets `SMTP_SECURITY=none`, so a deployment that sets `SMTP_USER`/
  `SMTP_PASSWORD` but forgets the flag fails closed instead of submitting the
  password in the clear. `ENVIRONMENT=production` suppresses the dev-only
  fallback that logs a one-time link when SMTP is off; `docker-compose.yml`
  defaults `ENVIRONMENT` to `development` because it is the local-run path
  (with no SMTP and production semantics, the reset flow would silently do
  nothing) — a real deployment must set it to `production`. Unset
  `FRONTEND_URL` silently points emailed links at `http://localhost:3000` —
  every deployment that sends mail must set it (docker-compose passes
  `FRONTEND_URL` through; `scripts/demo-tunnel.sh` sets it to the tunnel URL).
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
- `app.log` is written at runtime (logging configured in
  `app/logging_setup.py`, installed by `main.py`; records also stream to
  stdout with `threadName` and user/job context, and the file rotates at
  5 MB × 3); generated artifact, not source.

## Seeder & LOINC dictionary

- **One seeder**: `python -m app.db.seed_loinc` **drops and recreates the DB**,
  then seeds `biomarker_definitions` from `data/Loinc.csv` (lab-relevant
  classes, common-ranked — plus any code referenced by curated name overrides
  or multilingual/specimen synonyms even when `COMMON_TEST_RANK` is 0 or the
  CLASS is outside the common lab set, e.g. UA urinalysis codes) and applies
  curated reference ranges.
- The LOINC dictionary is the **single source of truth** for biomarker
  definitions — no separate baseline/seed module. `init_db` only creates
  tables.
- Ungrounded biomarkers extracted from a document are created dynamically as
  `scope=local` definitions at extraction time (id
  `local-{user_id}-{md5(name)[:12]}` — per-user, the same scheme as the
  manual-entry path; legacy tenant-blind `local-{md5(name)[:12]}` rows are
  renamed and their readings remapped by `migrate_local_definition_ids()`
  at startup, ISSUES.md #37), never pre-seeded.
- Seeding also writes `data/loinc_aliases.json` (folded-code → survivor-code
  map from the dedupe step). It is **committed** and load-bearing: the
  matcher's curated-code redirect (`matcher/loinc_store.py`) silently degrades
  without it (folded codes get promoted as duplicate globals). The file is
  deterministic from the tracked inputs — recomputed aliases always match.
  Within one display name, the survivor is chosen by curated reference range
  first, then a `loinc_name_overrides.json` entry (so curated codes anchor the
  fold, e.g. `22664-7` urea mmol/L over `3091-6` mg/dL), then lowest
  `COMMON_TEST_RANK`.
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
  qualitative (mismatch), `""` (unknown) for a numeric value against an
  unrecognized qualitative expected, **computed at save time by
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
  The cookie is **persistent** (`Max-Age` = 30 days): it is the only handle on
  the anonymous session's data, so a browser restart must not orphan it.
- `get_current_user_or_anon_strict` (import-job + notification endpoints):
  a token that IS present but fails to validate (bad signature, unknown
  user, expired, or superseded by a session-version bump) is a hard 401 —
  never the anonymous fallback; a fully ABSENT token still degrades to the
  anonymous session. Guards against the
  frontend's mount-time auth race answering with another principal's (empty)
  list as a 200, which the client would cache until the next poll tick.
- The raw cookie is **never** trusted as the authorization principal: forging it
  to another tenant's id (registered uuid or another anon id) yields a brand-new
  session, never the victim's data. A hard cutover — legacy unsigned cookies are
  unconditionally rejected — means data behind existing pre-fix anon cookies is
  orphaned.
- Registration-time data migration (`/api/auth/register` `migrate_data`) only
  reads the anon id through `verify_anon_cookie`, so a forged/legacy cookie can
  never copy another user's data into the new account.
- A **share token is a third principal class** (see "Public share surface"):
  a request that carries one has no session, sets no cookie, writes no
  `UsageLimit` row, and is resolved by `resolve_share_context` alone.
- **Wire contract**: `BiomarkerDefinition` / `BiomarkerDefinitionResponse`
  (and therefore every timeline/flowsheet/detail `definition` object) do **not**
  expose `user_id`. Definitions are serialized through `definition_schema` in
  `app/api/_serializers.py`; the owner id stays server-side so def lookups can
  never leak a tenant id into a client's matrix.

## Public share surface (`app/api/share.py`, `app/services/share_links.py`)

A share link is a third principal class: **not a session**, no cookie, no
`UsageLimit` row. It is the only way a request with no credentials reads a
tenant's data, and it is deliberately one code path.

- **Token storage**: `hp_` + 32 random bytes, stored ONLY as SHA-256 hex in
  `share_links.token_hash` (unique index) — the `PasswordResetToken` precedent.
  The raw value is returned once, in the create response, so the sender can
  never re-display a link; "resend" means "create a new one".
- **Transport**: the recipient URL is `/s/<token>` (the link is the URL), but
  the API call carries the token in the `X-Share-Token` header against constant
  paths (`/api/share/record`, `/api/share/flowsheet`). No path or query string
  ever contains a live credential, because this repo has no log-scrubbing
  layer — uvicorn writes request paths to stdout and they end up in bug
  reports.
- **One enforcement point**: `resolve_share_context` is the only place a
  client-supplied string becomes a tenant id. Missing, unknown, revoked and
  expired tokens all return one identical 404 with one localized detail, so a
  stranger who finds a dead token learns nothing about what it was. Both
  public GETs depend on it, so no public endpoint can read owner data without
  passing through it.
- **The public ENDPOINTS are GET-only, with no tenant id and no overrides**:
  they take no `patient_id`, no scope, no `include_*` and no `format`; every
  choice is read from the link row. The module also carries the owner routes
  (`POST /api/share/links`, `…/{id}/revoke`, `…/revoke-all`, plus
  `GET /api/share/notice` and `POST /api/share/notice/ack`), which authenticate
  normally and are unreachable with only a share token. No existing router
  gains an alternative auth path, so no write endpoint is one dependency-swap
  from being public.
- **No session minting**: the public routes depend on `resolve_share_context`,
  never `get_current_user_or_anon` (which calls `get_or_create_anon_id` and
  sets a cookie). A recipient is a stranger even if they happen to be a
  logged-in user.
- **Always current**: every read is a fresh DB read through the same builders
  the authed timeline/flowsheet use, with `Cache-Control: no-store` and
  `X-Robots-Tag: noindex, nofollow`. Revocation and expiry are evaluated on
  request, so they take effect on the recipient's very next load — provided
  nothing in front of the resolver caches.
- **Payload differences from the tenant timeline**: attachments never travel
  (`include_attachments=False` on the event/visit/instrumental builders), merged
  readings are excluded (D15 — the flowsheet and print rules), and
  `canonical_unit_inferred` is dropped (owner-facing verification UI). Entry
  free-text `notes` are absent because the timeline payload shape never
  carried them.
- **Scope (Stage 2, S5)**: a link's `scope` is either NULL — the whole record,
  reported as `{"kind": "all"}` — or `{"kind": "range", "from", "to"}` at
  whole-day granularity with either end optional. It is validated at create
  (unknown kind / unparseable date / `from > to` → localized 400) and only
  ever NARROWS: `share_links.date_range_from_scope` turns it into a `DateRange`
  of UTC day boundaries (`from` = 00:00:00, `to` = 23:59:59.999999 of that
  day), and `_apply_date_range` is applied to the builders the public path
  calls — `_events_from_db`, `_biomarkers_from_db`, `_visits_from_db`,
  `_instrumental_from_db` (`app/api/timeline.py`) and `_build_flowsheet`
  (`app/api/flowsheet.py`). The authed routes pass no range, so their behaviour
  is unchanged. Filtering the blood-test ENTRY set is what filters each
  biomarker's reading history too — a reading whose entry is outside the window
  cannot reappear inside another entry's history. `meta.scope` reports the real
  scope.
- **Expiry is validated against the principal (Stage 2, S4)**: the create body
  carries `expiry_days` (and `scope`, `include_header`), and the router — not
  the dialog — enforces registered `1 | 7 | 30` vs anonymous `1 | 7`, because
  an anonymous session is itself capped at 7 days (technical plan §11). A
  refusal is a 400 with a localized detail (`share.expiry_not_allowed`), so the
  server cap and the UI cannot drift apart.
- **Open counters (Stage 2, S2)**: `open_count` / `first_opened_at` /
  `last_opened_at` on the link row, written by ONE debounced conditional
  UPDATE (`share_links.mark_opened`, `SHARE_OPEN_DEBOUNCE_SECONDS = 300` in the
  WHERE clause, so two concurrent opens cannot both pass and a refresh inside
  the window leaves no trace). That same statement records the owner's current
  record watermark in `first_open_record_at` / `last_open_record_at`, so "came
  back after new data" is `open_count > 1 AND last_open_record_at >
  first_open_record_at`. It remains the feature's only write on a GET: no IP,
  no user agent, no per-visit rows.
- **Record watermark and the new-data notice (Stage 2, S9)**: the watermark is
  `MAX(medical_entries.created_at)` for the owner (`share_links.record_watermark`).
  `notified_record_at` is initialised to it at creation, so pre-existing data
  never raises a notice, and only `POST /api/share/notice/ack` bumps it — on
  every non-revoked link (expired included; revoked rows are closed history).
  `GET /api/share/notice` and `GET /api/share/links` are pure reads that
  compute `show` / `has_new_data` on the fly (`state` is `active | expired |
  revoked`, revoked wins). Accepted limitation: the watermark derives from
  entry `created_at`, so deleting an entry does not move it back; a dedicated
  `record_changed_at` column is deferred until a stamp proves load-bearing.
- **Funnel table (Stage 2, S1)**: `share_funnel_events` (`event`,
  `is_anonymous`, `created_at`) mirrors `ImportFunnelEvent` and is write-only.
  Rows are SENDER actions only — `link_created` and `link_revoked` — never
  deleted, one per action (revoke-all writes one per link actually closed; a
  repeat revoke writes nothing), and they carry no recipient identity, no
  token, no link id and no owner id.
- **Ops takedown (Stage 2, S7)**: `backend/scripts/revoke_share_link.py` takes
  the raw token from a report, hashes it, revokes exactly that row
  (idempotently) and logs the action without printing the token. There is
  deliberately no admin link list; the script addresses one reported link.
- **Anonymous senders**: identical code paths; the link dies with the cookie if
  the session is lost, and registering re-keys it onto the new patient id so
  the sender keeps revoke power.
- **Deletion**: `DELETE /api/auth/account` deletes the principal's links (a
  link owned by a deleted account must stop resolving). Expired and revoked
  rows are never swept — they are the sender's history.
- **Dead column**: `share_links.include_notes` is retained and never read or
  sent — entry notes never travel, and this repo's `migrate_add_columns()` only
  ever adds columns, so removing it would need a migration path that does not
  exist. `ShareLinkSummary` / `ShareLinkCreatedResponse` no longer expose it.

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
| `loinc_store.py` | LOINC CSV loading, `_promote_loinc_from_csv`, alias + multilingual/specimen lookup tables, `_specimen_compatible` SYSTEM guard |
| `name_matching.py` | Name index build, deterministic/fuzzy matching, grounding check, percent→fraction routing, carrier/generic-candidate guards |
| `specimen.py` | Specimen vocabulary (`blood|urine|feces|other|""`), alias normalization, local-name qualification |
| `llm_matching.py` | Candidate retrieval, zero-shot LOINC guess batch, verification backstop |
| `units_guess.py` | Unit translation to English + `_guess_unit()` empty-unit heuristics |
| `units_conversion.py` | Conversion factors (`convert_units`), cross-scale functions, canonical-unit landing |

### Specimen-aware matching (blood vs urine vs feces)

A generic spelling («Глюкоза», «Белок», «Гемоглобин») exists in several
biomaterials with different LOINC codes; without specimen awareness a urine
glucose folds onto the serum definition and both share one timeline series.

- **Extraction**: `RawMedicalRecord.specimen` carries the document's MAIN
  material (`blood|urine|feces|other|""`); `RawBiomarker.specimen` is a
  per-row override for mixed reports (an «Анализ кала» row inside a blood
  panel). Values are normalized by `matcher/specimen.normalize_specimen`.
- **Curated table precedence**: `data/specimen_synonyms.json` maps
  specimen-scoped names (checked first) to specimen-specific codes; its codes
  are always seeded (rank 0 included) and carry qualified display names from
  `loinc_name_overrides.json` (e.g. `15076-3 → "Glucose (urine)"`). Curated
  matches are authoritative and are NOT filtered by SYSTEM.
- **SYSTEM guard**: recall-driven matches (exact/fuzzy/LLM) are rejected when
  the candidate definition's LOINC `SYSTEM` conflicts with the reading's
  specimen (`_specimen_compatible`); the percent→fraction re-route is checked
  too. A rejected row falls to a local definition instead of a wrong global.
- **Local identity**: for `urine`/`feces` the specimen qualifier is part of
  the local definition's name AND id hash (`"Protein (urine)"`), so the same
  analyte in two specimens never unifies or compares across them. Blood is
  the unqualified default; `other` is a low-confidence catch-all and never
  changes identity.
- **Category**: urine codes are pinned to `Urinalysis` (`PANEL_BY_LOINC`,
  `LOINC_CLASS_TO_PANEL["UA"]`, `SOURCE_HEADING_TO_PANEL`).
| `translation.py` | Biomarker-name + visit-data LLM translation with fallbacks, date/time normalize |
| `definitions.py` | `verify_or_create` — definition resolution & persistence (first-seen canonical units anchor here) |
| `standardize.py` | `StandardizedBiomarker` builders, status apply, LLM-free fallback path |
| `pipeline.py` | The `match_and_convert` orchestrator |

## Backend module map (previously-undocumented modules)

Reference for agents so these aren't re-derived via grep each session:

| Module | Purpose |
|---|---|
| `app/db/models.py` | SQLAlchemy ORM models: `Patient`, `BiomarkerDefinition`, `BiomarkerReading`, `MedicalEntry`, `VisitData`, `InstrumentalData`, `Attachment`, `UsageLimit`, `CategoryTranslationCache`, `PasswordResetToken`, etc. |
| `app/db/import_ranges.py` | Curated common reference ranges (`COMMON_RANGES`) merged into existing global definitions; run via `python -m app.db.import_ranges`. |
| `app/services/extractor.py` | Pass-1 OCR→LLM raw extraction: turns document text into a `RawMedicalRecord` (raw biomarkers / visit / instrumental data) before the matcher runs. OCR markdown is deterministically de-boilerplated before any LLM call (`_clean_ocr_markdown`: separator rows, page furniture, keep-first dedupe of repeated non-tabular lines; `OCR_MARKDOWN_CLEAN=0` disables — the benchmark's A/B switch). |
| `app/services/extract_jobs.py` | Batch-import background jobs: `ExtractionJob` queue + daemon workers re-running the `/api/extract` stages, terminal notifications, global TTL sweep (GC), startup recovery, single-process pid guard, funnel counters. See the "Batch import" section below. |
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
  соотношение names) are dimensionless and anchor `ratio` BEFORE any unit
  translation — a log prefix OR a leaked concentration unit (e.g. a table-wide
  `мг/дл` column header) never becomes their canonical, and they never scale
  (ISSUES.md #46). Exception: when the document prints a percent unit, the
  printed `%` wins (e.g. P-LCR "Large Cell Ratio") — that is a real unit, not
  a leak.
  Canonical absent strings (`Not detected`, …) against a foreign canonical
  unit don't set `needs_review` (no quantity to convert), and a unitless
  (qualitative) def never leaks a raw unit column onto its readings.
- Deterministic unit mappings: haematology counts printed per litre
  (`10^9 клеток/л`, `10^12 клеток/л`) canonicalize to the seeded UCUM forms
  (`10*3/uL`, `10*6/uL`) without an LLM (`units_guess._count_per_liter_unit`),
  and `standardize.py` falls back to that matcher translation when
  `converters.normalize_unit` leaves a Cyrillic unit untranslated.
- Segmented/banded printed references (`желательный … <5.17, пограничный …`,
  `до 0.9 - отрицательный, …`) yield the first applicable band as an interval
  for NUMERIC readings (`matcher/reference_bands.py`); age/sex-qualified texts
  are deliberately left unparsed until patient demographics are available
  (picking a band without them would encode a wrong cutoff).
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
  cancellation always propagates. Every refund path runs through the stream's
  `_refund_once` guard, so a disconnect at (or after) the error-event yield —
  which the explicit failure path already refunded before yielding — cannot
  refund the same extraction twice and drain an earlier legitimate one.
- During the long silent OCR/LLM/matching phases the SSE stream emits
  `: keep-alive` comment lines every 15s (ignored by SSE clients and the e2e
  harness) so a healthy-but-slow extraction isn't mistaken for a dead one.
- The `extracting` and `matching` SSE `progress` events also carry
  `estimate_s` — the backend's own estimate of how long THAT stage will take,
  computed from the last ~20 recorded stage durations
  (`extraction_timing_samples` table, maintained by
  `app/services/timing_stats.py`: one row per completed stage, pruned on
  write). The extract estimate is a Theil–Sen intercept+slope fit over the
  recent (markdown chars, seconds) samples — modeling the ~2s fixed LLM cost
  keeps the estimate accurate across document sizes; ocr/match use flat
  medians. Samples that are implausibly fast (<0.25s — e.g. the mocked
  `/api/extract` test runs, whose stages complete in ~1e-4s) are rejected on
  write and ignored on read, so test pollution can't collapse the estimate
  to its floor (and legacy garbage rows become inert without a migration).
  Until a stage has ≥5 plausible samples the estimate falls back to
  constants fitted from historical timings (extraction ≈ 2s + 0.0023 s/char).
  Samples record only successful stages; `timing_stats` failures never break
  the stream. The frontend displays this value and keeps its own constants
  only as a fallback for older backends.

## Batch import: background extraction jobs (`app/services/extract_jobs.py`, `app/api/import_jobs.py`)

Companion to `docs/batch-import-tickets.md` (repo root). A user submits N
documents; a background worker extracts each one while the user browses or
leaves; finished jobs hold a STAGED result (`StandardizedMedicalRecord` dump
+ the uploaded file) that only becomes a real entry when the user reviews and
saves it. Nothing is persisted without user review.

### Job model & lifecycle

- `ExtractionJob` (`extraction_jobs`): `status` is
  `queued → processing → done|failed|cancelled`, plus the transient
  `saving` claim state used by save/merge (below). `progress` holds the same
  payloads as the SSE progress events (incl. `estimate_s`); `result` holds
  the staged record dump when `done`; `error_key`/`error_params` store the
  failure reason as an i18n catalog key, resolved via `i18n.tr_opt` at READ
  time (the worker thread has no request locale — same pattern as OCR error
  classification in `/api/extract`).
- `entry_type: "unknown"` is a SUCCESS (`done`, no refund) — mirrors the SSE
  path: the LLM genuinely ran and the user gets the unknown-editor.
- Worker: module-level `queue.Queue` + `IMPORT_WORKERS` daemon threads
  (default 1 — serial Mistral calls avoid the documented 429-contamination
  bug; values >1 are unsupported until a rate-limit strategy exists). The
  pipeline re-runs the exact `/api/extract` stages (OCR → LLM extract →
  source-language detect → matcher on the worker's OWN session with
  **commit-before-close / rollback-on-error** — the terminal write commits
  the match stage's anchored definitions). Sessionmaker is injected
  (`extract_jobs.set_sessionmaker`) so tests point the worker at the test
  engine instead of the file-backed global.

### Refund / charge authority (invariant)

- Quota is CHARGED at submit (`POST /api/import/jobs`, deferred commit after
  file validation) and refunded on failure/cancel — NEVER on client
  disconnect (a batch submit has none).
- Only the worker refunds a job it has dequeued (claim = CAS
  `queued → processing`). API-side cancel of a `processing` job only sets
  `cancel_requested` — the worker performs refund + staged-file cleanup
  between stages. A queued-job cancel is the one CAS refund the API may
  perform (`UPDATE … WHERE status='queued'` must win; losing the race means
  the worker just claimed it and the cancel falls through to the flag).
- Retry (`POST /api/import/jobs/{id}/retry`, failed→queued) re-charges quota
  atomically with the winning CAS transition (deferred commit in the same
  transaction); losing either the status race or the quota check changes
  nothing.
- GC expiry refunds non-terminal jobs (queued/processing) only; `done` jobs
  consumed their extraction, failed/cancelled were already refunded.

### Notifications & funnel

- `GET /api/import/jobs` returns ALL non-expired rows (active work +
  `saved`/`dismissed`/`cancelled` history); the frontend sections them. Each
  summary also carries `restorable` (a dismissed job that still holds its
  staged result — revivable via restore, below), `saved_entry_id` (the entry
  a `saved` history row produced; null otherwise) and `merge_conflicts`
  (display names of the staged blood-test record's biomarkers that already
  exist in a same-date blood-test entry — computed batched at list time by
  `_merge_overlap_conflicts`, mirroring the merge endpoint's rule:
  definition_id/LOINC equivalence; manual rows by exact name or
  synonym-substring, conservatively — it may over-warn (never under-warn)
  vs the server's fuzzy name resolution). A non-empty list means `POST
  /api/entry/{id}/merge` would refuse the merge with 409 — the tracker
  warns BEFORE the user enters the review editor (saving as a separate
  entry still works).
- `GET /api/import/jobs/{id}/file` serves the STAGED file to its owner
  (tenant-scoped; the /static/uploads route only authorizes
  Attachment-backed files) for the review editor's preview.
- Dismiss (`DELETE /api/import/jobs/{id}`; allowed from queued/done/failed —
  processing flags a worker cancel instead; `saved`/`cancelled`/`dismissed`
  are 409) deletes the job's notification rows. From `done` it KEEPS the
  staged file + result: a dismissed done-extraction is revivable via `POST
  /api/import/jobs/{id}/restore` (CAS `dismissed → done`, only when `result`
  is present; TTL-checked like the save claim; the staged file is verified
  AFTER the winning CAS with a rollback-to-dismissed on miss; the bell
  notification is recreated in the same commit, no funnel event). From
  `queued`/`failed` the file is freed immediately (no result → never
  restorable). Dismissed rows are PERMANENT history — they never disappear
  from the tracker; past the TTL the sweep only frees the file (file_size
  zeroed), which is what closes the restore window.
- `Notification` (`notifications`): exactly one row per `done`/`failed`
  terminal transition, written in the SAME commit as the job status change;
  cancelled jobs emit nothing. Plain `job_id` column + minimal `payload`
  ({job_id, filename}); unread = `read_at IS NULL`; retries produce several
  rows per job (GC/dismiss cascade deletes all of them). API:
  `GET /api/notifications`, `POST …/{id}/read` (idempotent), `POST
  /read-all`, `DELETE …/{id}` (dismiss deletes ONLY the bell row — the
  staged job expires via GC on its own).
- `ImportFunnelEvent` (`import_funnel_events`): one aggregate counter row
  per transition — `submitted` (submit), `extracted` (done incl.
  unknown-type), `saved` (reviewed entry consumed the job), `failed`.
  Cancelled jobs write nothing. Answers "docs imported per new user" and
  "review completion rate" (saved/extracted) before a review fast-track is
  ever considered. Rows are never deleted. Deliberately write-only for now:
  the data is collected ahead of the planned metrics/dashboard work
  (ISSUES.md) — nothing in the app reads it yet.

### Save / merge with `import_job_id`

- `POST /api/entry` and `POST /api/entry/{id}/merge` accept an optional
  `import_job_id`: the staged file is adopted with NO re-upload (Attachment
  points at the staged path; name/size from the stored file) and STORAGE
  quota is charged here — staging is free. The save CAS-claims the job
  (`done → saving`) inside the save transaction so the GC sweep (which
  skips `saving` rows) can never unlink the file mid-save. On success the
  job row is NOT deleted: it becomes a HISTORY record
  (`status='saved'`, `saved_entry_id` set, `result`/`progress` cleared, bell
  notification rows deleted) so the imports tracker can show past imports.
  Any failure rolls the claim back — the job stays `done`, the file stays
  staged, storage stays uncharged.
- Anon→register migration (`copy_anonymous_data`) RE-KEYS
  `ExtractionJob.user_id`, `Notification.user_id` and `ShareLink.owner_id`
  (one-statement pattern, same as `UsageLimit`): staged jobs stay reviewable
  after registration and their refunds hit the registered counter, and a link
  created before registering keeps serving the *live* record while the sender
  keeps the ability to revoke it. (Share links are re-keyed, not copied — a
  link left on the anon id would serve the frozen anonymous copy forever.)

### Expiry, startup recovery, single-process constraint

- GC (`IMPORT_JOB_TTL_H=72`): a GLOBAL sweep (never caller-scoped — dead
  users' files must not linger) run lazily from the import API (submit +
  list-read). Deletes expired rows + staged files
  (`unlink_unreferenced_files`) + the jobs' notification rows (the bell must
  never offer "Review" on a 404'd job). `saving` claims and `saved`/
  `dismissed` history rows are never row-deleted — `saved` forever (its file
  is the entry's Attachment), `dismissed` stays visible forever too, but an
  expired dismissed row loses its staged FILE (file_size zeroed), which is
  what ends the 72h restore window. Every sweep mutation is a conditional
  UPDATE/DELETE (`id` + snapshot `status` + `updated_at < cutoff`): the
  candidates are read without a write lock, so the guard makes the sweep LOSE
  to any concurrent CAS transition (worker claim, cancel, retry, dismiss,
  restore, save) instead of deleting a live job — and a refund is issued only
  for rows whose DELETE actually won, so a job can never be refunded twice.
- The per-user pending cap at submit bounds the uncharged-storage worst
  case: the job-count cap counts `queued`/`processing`, the staged-bytes cap
  counts every job still holding a file (`queued`/`processing`/`done`/
  `failed`/`dismissed`; the sweep zeroes an expired dismissed row's
  file_size, taking it out of the cap).
- Startup recovery (app lifespan, after `assert_single_process`): orphaned
  `processing` rows → `failed` via CAS + refund + failed notification (the
  worker that owned them died with the old process); orphaned `queued` rows
  → re-enqueued into the fresh queue; orphaned `saving` rows → restored to
  `done` (crash mid-save; the extraction already succeeded).
- **Single-process constraint**: the queue is per-process. A pid file next
  to the SQLite DB makes a second app process against the same DB fail
  loudly at startup. `uvicorn --workers N` or a scaled backend container is
  UNSUPPORTED — raising it later requires a real broker + lease-based
  recovery.
- SQLite concurrency substrate: WAL + `busy_timeout` are enabled on
  file-backed engines in `app/db/session.py` (the compose DB mount is a
  directory so the sidecar files persist). A batch worker and an interactive
  single-doc SSE extraction CAN run concurrently — two Mistral consumers;
  acceptable (SDK retries + refunds bound it), documented, not a bug.

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
- `specimen` (record-level main material + optional per-row override) drives
  specimen-aware matching; see the matcher section above. A missing document
  date stays empty — the matcher never fabricates one.
- Blood-test reports never carry `visit_data`: a per-analyte «Комментарий»
  column is not a recommendation (the pipeline clears it for `blood_test`).
- Instrumental reports: `modality` must be exactly one of the fixed list
  `MRI, CT, X-Ray, Ultrasound, Elastography, Mammography, PET Scan, ECG,
  Endoscopy, Other` (mirrors the frontend `MODALITIES`); content goes to
  `findings`/`conclusion`; `notes` stays empty (no duplication).

## Source-document language (`medical_entries.source_language`)

- Detected **deterministically** on the full OCR markdown inside the extract
  stream (`app/services/language_detect.py`: script ranges → Cyrillic `ru`,
  Hebrew `he`; Latin-script common-word + Polish-diacritic scoring). Never an
  LLM field — prompt changes would risk e2e golden drift for a field the
  goldens never compare. Allowlist: `en de fr es pl ru he`; short/ambiguous
  documents detect as `None`.
- Rides both `/api/extract` result events on
  `StandardizedMedicalRecord.source_language`; the client relays it as an
  optional `source_language` Form field on `POST /api/entry`, which stores it
  only when it is in the allowlist (else NULL). Nullable column, no backfill —
  legacy/manual entries are NULL; auto-migrated by `migrate_add_columns()`.
- Surfaced on timeline `MedicalEvent.source_language`, flowsheet
  `DateHeader.source_language` (per date column), and
  `MatrixRow.original_lang` (language of the entry whose first reading
  supplied the row's `original` — mixed-language document sets make this
  differ from the column's language). The print editor uses the date-column
  value to label "Keep Original"/bilingual original content; mixed or unknown
  columns fall back to a generic "Original" label.

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
- Storage quota is refunded in one `UPDATE UsageLimit` per delete: the
  counter is floored at zero (CASE, so drift self-heals) and only files that
  were actually unlinked (or already missing) are refunded — a still-shared
  file is kept and refunds nothing.
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
- Merged readings are excluded from `GET /api/flowsheet` server-side (the
  batched readings query filters `merged IS FALSE`): the flowsheet matrix
  cells, the derived `biomarkers` list (print/export picks its rows from it),
  and correlation see original readings only. `/api/timeline` keeps surfacing
  them (`merged` / `merged_source` per reading) — the timeline details view is
  their only home. `MatrixCell` therefore has no `merged` field (removed; it
  was never read by any client).
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

## Full-data export (`GET /api/export`, `app/api/account.py`)

- Read-only backup of the caller's structured data: no LLM calls, no quota
  charge, no `UsageLimit` row touched (export is not AI usage). Auth is
  `get_current_user_or_anon` — anonymous sessions export their own data too.
- JSON (default): versioned envelope `{format: "healthpassport-export/v1",
  exported_at, account, usage, entries, biomarker_definitions}`:
  - `account` — the Patient profile (id/email/name/dob/gender) for registered
    principals; `{id, is_anonymous: true}` for anonymous;
  - `usage` — the same payload as `GET /api/usage/limits` (via `get_limits`);
  - `entries[]` — every entry of the caller (ordered `(date, created_at, id)`
    like the timeline) with entry columns (incl. `notes`, `source_language`,
    `created_at`) and nested `biomarker_readings[]` (ALL columns: value /
    value_text / reference snapshot / status / original_* / scale_function /
    needs_review / merged / merged_source), `attachments[]` metadata (incl.
    `file_path`), `visit_data` (object|null), `instrumental_data`
    (object|null);
  - `biomarker_definitions[]` — the caller's `scope=local` rows only,
    column-for-column; global LOINC definitions are derivable from the
    dictionary and are NOT exported.
- `?format=csv` — one row per reading across the caller's entries (joined
  with the owning entry and the reading's — possibly LOINC-legacy —
  definition), `text/csv` UTF-8 with BOM,
  `Content-Disposition: attachment;
  filename="healthpassport-readings-YYYYMMDD.csv"`. A `0.0` value or
  reference bound stays `0.0` in the cell (never collapsed by falsiness);
  readings whose definition row is unresolvable still export with empty
  name/unit cells. The format value is case/space-insensitive; anything
  other than json/csv → 400 with localized detail (`export.invalid_format`).
- Tenant scoping mirrors every other endpoint: entries by `patient_id`,
  local definitions by `user_id` — a principal can never see another's rows.

## Response localization (`app/i18n.py`, Accept-Language)

- User-facing backend text — HTTPException `detail` strings, SSE `error`
  messages, and the small JSON success `message` fields — is localized EN/RU.
  `app/i18n.py` holds the `MESSAGES` catalog (stable keys → `{en, ru}`;
  the English values are byte-identical to the pre-localization literals) and
  `tr(key, **kwargs)` / `tr_opt(key)` lookup helpers.
- A pure-ASGI `LocaleMiddleware` (mounted in `app/main.py`) parses the request
  `Accept-Language` header once per request and stores the resolved locale
  (`en` | `ru`, q-value aware, EN fallback) in a ContextVar. Endpoints, sync
  handlers (via starlette's context-copying threadpool) and the SSE
  `event_stream` generator all read the same value. **No header ⇒ byte-identical
  legacy English behavior**, which the existing suite relies on
  (`tests/test_i18n.py` covers both).
- OCR error messages are classified inside an executor thread where the
  ContextVar is invisible, so `app/api/ai.py` localizes them AFTER the fact
  from `OCRProcessingError.kind` (`ai.ocr_*` keys; the auth kind carries
  `http_status` for interpolation). Unmatched kinds fall back to the error's
  own English message. LLM extraction hard failures are localized the same
  way from `LLMProcessingError.kind` (`ai.llm_*`): the SSE stream resolves
  the key in-request, the batch worker stores it as the job's `error_key`
  and the read path localizes it.
- Catch-all SSE stream errors now emit the localized `ai.extract_failed`
  (the raw exception text stays in the logs only).
- Still English by design: pydantic/FastAPI 422 validation messages,
  DB-persisted strings (entry titles, "Labs",
  note headings, "Raw OCR text:"), category/panel names, biomarker names and
  units. The frontend requests RU by sending `Accept-Language` on every API
  call (see `frontend/docs/architecture.md`).
- Every email (`app/services/mailer.py`: password reset, email-change
  confirmation, email-change notice) is bilingual (English block + Russian
  block, each carrying its link) because there is no per-user language
  preference in the data model.
- The public share surface returns only localized `detail` strings
  (`share.link_unavailable`, `share.link_not_found`, `share.too_many_requests`)
  — the record payload itself carries **no** server-localized prose, because it
  is data: biomarker names come from the persisted multilingual `names` map and
  the chrome is localized by the frontend from its own catalogs.

## Auth & password reset (`/api/auth`)

- Registration/login are credentials-based; the frontend proxies them through
  NextAuth (`/api/auth/register`, `/api/auth/login`). Passwords are bcrypt
  hashed (`app/auth.py`) and must be at least 8 characters and at most 72
  bytes (bcrypt truncates at 72; enforced on register, change-password and
  reset; overlong login input fails verification instead of erroring). JWTs
  are signed with `SECRET_KEY`/`.jwt_secret`.
- Password recovery: `POST /api/auth/forgot-password {email}` and
  `POST /api/auth/reset-password {token, new_password}`.
  - `forgot-password` always returns 200 with the same body whether or not the
    email exists (no user enumeration; a mailer failure is logged and also
    returns 200). Delivery is queued as a Starlette `BackgroundTasks` step, so
    a registered address does not pay the SMTP round-trip inside the response
    (that latency would itself reveal whether the account exists). If the user
    exists it stores a 30-minute, single-use token —
    only its SHA-256 hash is persisted in the `password_reset_tokens` table
    (`token_hash`, `patient_id`, `expires_at`, `used_at`) — and emails the raw
    token via `app/services/mailer.py`. Expired and used tokens are purged on
    each request (both reset and email-change tables). The emailed link always uses the
    configured `FRONTEND_URL` (default `http://localhost:3000`) — request
    Origin/Referer headers are never trusted, since a direct API caller could
    otherwise rewrite the link to a phishing domain holding a valid token. In
    local dev (`SMTP_ENABLED` unset, the default) the reset link is logged
    instead of emailed — unless `ENVIRONMENT=production`, where the link is
    never written to the log (a logged one-time link is an account takeover).
    Endpoint is rate-limited in-memory (5/hour per email, 20/hour per IP).
  - `login` throttles FAILED attempts in-memory (10/15 min per email,
    30/15 min per IP; ISSUES.md #51) — successful logins never consume the
    window, and a full window refuses even correct credentials with 429.
- `GET /api/auth/email-delivery` (public) returns `{enabled: bool}` — whether
  this instance has an SMTP transport at all. It is account-independent (it
  leaks nothing about any user), and it exists because the reset endpoint's
  uniform 200 makes per-address delivery reporting impossible; the UI uses it
  to stop promising an inbox that will stay empty when SMTP is off.
  - `reset-password` validates the token (exists, unused, unexpired), enforces
    the ≥8-char/≤72-byte password rule, replaces `patients.hashed_password`, and
    claims the token with a conditional `used_at IS NULL` UPDATE (a concurrent
    replay loses with 400). It also bumps `patients.token_version`, so every
    JWT issued before the reset is rejected from now on — the remedy the
    email-change notice recommends has to actually evict an already-stolen
    session. The user signs in again with the new password.

- **Email change** (roadmap 0.4): `POST /api/auth/change-email
  {current_password, new_email}` + `POST /api/auth/confirm-email-change
  {token}`. **Double opt-in by construction**: requesting is registered-only
  (`get_current_user`; anonymous fails 401), re-verifies the current bcrypt
  hash (wrong → 400 `auth.incorrect_password`), rejects the caller's own
  address case-insensitively (400 `auth.email_unchanged`, so a no-op never
  burns an email), and is throttled per account (5/hour). An address owned by
  ANOTHER account is deliberately NOT reported (a 409 there was a
  user-enumeration oracle: any signed-in user with their password could probe
  whether an arbitrary address exists): the request answers the same uniform
  200 as for a free address and emails that address a "someone tried to use
  it" notice instead (`send_email_change_squatted_notice`, queued as a
  `BackgroundTasks` step so timing matches too); no token row is staged. The
  requested address is normalized (trim + lowercase) first.
  It writes a 30-minute single-use `email_change_tokens` row — `new_email`
  plus the SHA-256 token hash, never the raw token — and emails the
  confirmation link to the **new** address; `patients.email` is NOT touched,
  so a typo cannot lock the owner out. Confirming validates the token
  (exists/unused/unexpired), re-checks the address (409 if it was claimed in
  the meantime; the `UNIQUE(email)` index is the real guard — a losing
  concurrent registration surfaces as `IntegrityError` → 409), claims it with
  the same conditional-UPDATE CAS, rewrites `patients.email` (normalized),
  bumps `patients.token_version` — sessions issued under the OLD address,
  including a thief's, are dead from that moment — and emails a notice to the
  **old** address pointing at `/forgot-password`, which is now a real recovery
  path rather than a cosmetic suggestion. (The confirm-time 409 is NOT an
  oracle: it needs a token that was emailed to the address, so it is
  unreachable for an address the caller does not control.) The confirm
  endpoint is public, like `reset-password`: the token proves control of the
  new address, so it works while signed out. JWTs carry a now-stale `email`
  claim, which is cosmetic — authorization reads only `sub`.

- **In-app password change**: `POST /api/auth/change-password
  {current_password, new_password}` — registered only (anonymous principals
  fail `get_current_user` with 401, mirroring `/api/auth/me`), verifies the
  current bcrypt hash (wrong → 400 `auth.incorrect_password`), enforces the
  same ≥8-char/≤72-byte rule, and re-hashes. It bumps `token_version` too, so
  every session — the caller's own included — is retired and the user signs in
  again with the new password.

- **Session version (`patients.token_version`)**: every JWT is issued with the
  account's current version as the `tv` claim (`issue_access_token`), and
  `get_current_user` rejects a token whose claim is behind the row: expired
  tokens raise `TokenExpiredError`, superseded ones `TokenStaleError` (both
  `ReauthRequiredError`) with 401 `auth.session_invalidated`. The marker type
  is what keeps `get_current_user_or_anon` honest — a token that WAS valid must
  never silently degrade to an anonymous session. A token without the claim
  (issued before the column existed) reads as `0`, the column default, so the
  migration itself logs nobody out. Added to existing DBs by
  `migrate_add_columns()`. Addresses are also normalized (trim + lowercase) on
  register / login lookup / both email-change paths, with legacy rows rewritten
  by `migrate_normalize_emails()` (rows colliding only by case are reported and
  left alone: two accounts on one mailbox is a product decision).

- **Account self-deletion**: `DELETE /api/auth/account` — works for BOTH
  principals (registered delete the whole account, anonymous wipe their
  session's data). Cascade order mirrors `DELETE /api/entry`: entries first
  (the ORM cascade removes readings, visit_data, instrumental_data and
  attachment rows) → on-disk files unlinked only when no other `Attachment`
  row still references the path (the anon→user migration duplicates rows
  across principals; shared helper `app/services/upload_cleanup.py
  unlink_unreferenced_files`, also used by `DELETE /api/entry`) → the
  caller's `scope=local` definitions (reading-free by then) →
  `PasswordResetToken` rows → the `UsageLimit` row → the caller's
  `ShareLink` rows (roadmap 1.1: a link owned by an account that no longer
  exists must stop resolving rather than keep serving a record nobody can
  revoke) → the `Patient` row
  (registered only; anonymous principals have no Patient row). An anonymous
  deletion also clears the anon cookie so the next visit starts a fresh
  session. Response: `{message (localized), deleted_entries, freed_bytes}`.

## DB migrations

New model columns are added to existing DBs by `migrate_add_columns()` in
`app/db/session.py` (called from `init_db`; `create_all` only creates missing
tables, not missing columns).

New TABLES need no migration step: `create_all` creates them on the next boot,
so `share_links` (roadmap 1.1) appears on a long-lived DB by restarting. Any
column added to it later goes through `migrate_add_columns()` like every other.
