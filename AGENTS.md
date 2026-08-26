# AGENTS.md

Repo: **HealthPassport** — FastAPI backend + Next.js (React 19) frontend, two independent apps under `backend/` and `frontend/`. No workspace build tool ties them; run/test them separately.

## Read these before touching an area

Deep architecture details live in on-demand docs — read the relevant one first, don't rely on AGENTS.md alone:

- `backend/docs/architecture.md` — reference model, unit canonicalization, `/api/extract` persistence rules, delete/merge semantics, DB migration.
- `frontend/docs/architecture.md` — proxy rewrites, reference formatting, merge/unit-conflict UI contracts, settings tab.
- `backend/e2e/README.md` — golden harness, isolated-server rules, add-case workflow.

**Keep docs in sync — only for significant changes**: update the affected
on-demand doc(s) — `backend/docs/architecture.md`,
`frontend/docs/architecture.md`, `backend/e2e/README.md`, and the AGENTS.md
invariants if they change — **in the same change, but only when the change
makes a documented statement false** (an observable contract: API shape,
persisted data model, reference/status semantics, matcher/unit rules, proxy
rewrites, merge/unit-conflict UI behavior, harness/safety behavior). Skip
doc updates for cosmetic or mechanical changes — typos, formatting, internal
renames, tests, tooling/dependency bumps, log messages — without flagging
them. For refactors that keep observable behavior identical, skip doc edits
but state in your report that no documented statement changed. When in doubt,
flag drift to the user rather than editing docs. AGENTS.md is the index, the
architecture docs are the truth.

## Quick commands

- Backend API: `uvicorn app.main:app --port 8000` (from `backend/`, venv active; venv at `backend/venv/`).
- Backend tests: `python -m pytest tests/ -v` (from `backend/`). In-memory sqlite via `tests/conftest.py`; no DB setup or `MISTRAL_API_KEY` needed.
- Backend lint: `venv/bin/ruff check .` (from `backend/`).
- Frontend dev: `pnpm dev` (port 3000). Lint: `pnpm lint`. Unit tests: `pnpm test` (vitest run, jsdom, `@/` → `src/`). No frontend e2e suite — backend golden harness covers e2e.
- Seed LOINC: `python -m app.db.seed_loinc` — **drops and recreates the DB**. LOINC dictionary is the single source of truth for biomarker definitions. Run once; keep stable while a golden is in use.
- E2E: `python backend/e2e/run_e2e_server.py` (isolated uvicorn, own DB; never port 8000, never `pkill`).
- Extraction benchmark (ISSUES.md #24): `venv/bin/python benchmark/run_benchmark.py --runs 3` from `backend/` — LIVE pipeline over `benchmark/corpus/`, real Mistral spend; loop usage in `.opencode/skills/autoresearch/SKILL.md` and `benchmark/README.md`.

## Backend invariants (always true)

- **Required env**: `MISTRAL_API_KEY` (in `.env`) — OCR/extraction/matching in `ai.py`. `.env` and `.jwt_secret` are committed dev-only secrets.
- **Reference model**: every biomarker definition and reading carries a single structured `reference` JSON column whose `kind` IS the result type — `{kind:'interval', low, high}` numeric, `{kind:'qualitative', expected}` text. No separate `result_type`; the kind is the sole discriminator. `status` is `low|normal|high` for intervals, `normal|abnormal` for qualitative, **computed at save time and persisted** to `biomarker_readings.status` (not recomputed on read).
- **CRITICAL — `/api/extract` persists definitions**: matching runs in a worker thread (`backend/app/api/ai.py`, `_match_in_thread`) using its own `SessionLocal()`. It MUST `commit()` before `close()` (and `rollback()` on error), or definitions + canonical units are silently lost and sequential extractions "forget" units. #1 thing to check.
- **Unit canonicalization** (`app/services/matcher/` package — facade `__init__.py`, units in `units_conversion.py`/`units_guess.py`): canonical unit set on the FIRST reading that creates the def (first-seen wins). Later readings converted via `scale_function`; `lg` unit prefix MEANS log10 (do not "fix" it to linear — reverted twice). Empty units handled by `_guess_unit()`, never the batch LLM translator.
- `app.log` is a generated runtime artifact.
- New columns are added to existing DBs by `migrate_add_columns()` in `app/db/session.py` (called from `init_db`).

## Frontend invariants (always true)

- API calls proxied server-side via `next.config.mjs` rewrites: `/api/*` (except next-auth paths) and `/static/*` → `STATIC_PROXY_URL` (default `http://localhost:8000`, Docker `http://backend:8000`). Don't add client-side API base URLs that bypass this.
- AI-guessed units (`canonical_unit_inferred`) are flagged ONLY in the add-entry editor (`LabResultForm.tsx`, blue ring + hover tooltip). The old amber `InferredUnitNote` triangle is **removed** from the timeline and flowsheet — do not re-add it there.
- Merged readings appear **only** in the timeline details view (`results-panel.tsx`) under `MergedSectionHeader`; flowsheet and print editor exclude them. `biomarkersAtDate` copies `merged`/`merged_source` from the reading AT the selected event (`isLatest`-gated) — never a `??`-fallback to the latest reading.

## Docker / CI

- `docker-compose.yml` builds both services; backend mounts `./backend/.env` and persists DB + uploads as volumes. Frontend needs `STATIC_PROXY_URL=http://backend:8000`.
- CI (`.github/workflows/tests.yml`): two jobs (backend pytest, frontend vitest), triggered on `backend/**` or `frontend/**`. The e2e golden harness is NOT in CI — run manually via `run_e2e_server.py` / verify with `validate_offline.py`.
