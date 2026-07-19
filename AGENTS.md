# AGENTS.md

Repo: **HealthPassport** — FastAPI backend + Next.js (React 19) frontend, two independent apps under `backend/` and `frontend/`. No workspace build tool ties them; run/test them separately.

## Backend (`backend/`)
- Python 3.9. Package manager: pip into a local `venv/` (already present). Install: `pip install -r requirements.txt`.
- Run API: `uvicorn app.main:app --port 8000` (from `backend/`, venv active). `main.py` calls `load_dotenv()` and `init_db()` on startup.
- **DB env**: defaults to `sqlite:///./health_passport.db`. Override with `DATABASE_URL`. Tests use an in-memory sqlite via `tests/conftest.py` (db is auto-created/seeded per test, no DB setup needed).
- **Required env**: `MISTRAL_API_KEY` (in `.env`) — needed for OCR/extraction/matching in `ai.py`. `.env` and `.jwt_secret` are committed here (dev-only secrets; do not treat as production-safe).
- **Two seeders, different scope**: `init_db`/`seed_db` seeds only 18 baseline biomarker definitions. For the full LOINC dictionary run `python -m app.db.seed_loinc` once (required for realistic `/api/extract` and e2e). Keep the dictionary stable while a golden is in use or mappings drift.
- Run backend tests: `python -m pytest tests/ -v` (from `backend/`). `pytest.ini` sets `asyncio_mode = auto`; `pytest-asyncio` + `httpx` are used. The test `client` fixture builds its own FastAPI app with dependency overrides — it does NOT test `main.py` wiring or the `/static/uploads` route.
- `app.log` is written at runtime (logging to file in `main.py`); it is a generated artifact, not source.

## Frontend (`frontend/`)
- Node 22, package manager **pnpm@11.9.0** (enable corepack). Install: `pnpm install --frozen-lockfile`. `pnpm-workspace.yaml` only whitelists `sharp` builds.
- Next.js 16, `output: 'standalone'`, **images `unoptimized`**, `recharts` transpiled. API calls are proxied server-side via `next.config.mjs` rewrites: `/api/*` (except next-auth paths) and `/static/*` → `STATIC_PROXY_URL` (default `http://localhost:8000`, Docker uses `http://backend:8000`). Don't add client-side API base URLs that bypass this.
- Dev: `pnpm dev` (port 3000). Lint: `pnpm lint`. Unit tests: `pnpm test` → `vitest run`, jsdom env, `@/` → `src/` alias.
- **E2E**: `pnpm test:e2e` → Playwright. `playwright.config.ts` auto-starts BOTH a uvicorn backend (cwd `../backend`, CI uses `DATABASE_URL=sqlite:///./e2e_test.db`) and the frontend dev server. Requires `npx playwright install chromium`. Local e2e reuses existing servers if running; CI does not.

## E2e golden harness (`backend/e2e/`)
- Pure HTTP client against the live server (`POST /api/extract`), diffs output vs hand-verified `golden/<case>/standardized.json`. Imports no app code.
- Run: `python backend/e2e/run_e2e.py [--case <name>] [--regen-golden] [--url <url>] [--token <jwt>]`. Non-zero exit only on verified-golden mismatch; pending/unreviewed goldens don't fail.
- Add a case: drop a doc in `inputs/<case>/`, then `run_e2e.py --regen-golden`, review the generated golden, commit only verified ones. Record matcher mismatches in `KNOWN_ISSUES.md`.

## Docker
- `docker-compose.yml` builds both services; backend mounts `./backend/.env` and persists `health_passport.db` + uploads as volumes. Frontend needs `STATIC_PROXY_URL=http://backend:8000`.

## CI (`.github/workflows/tests.yml`)
- Three jobs (backend pytest, frontend vitest, Playwright e2e), triggered on `backend/**` or `frontend/**` changes. E2e job installs Python + pnpm + Chromium and runs all servers itself.
