---
description: Run full local CI parity — backend tests + lint, frontend lint + typecheck + tests.
---

# Verify HealthPassport

Run every check CI runs, in one shot. Report pass/fail **per check** and
declare success only when all are green. Run the backend and frontend
groups independently (they don't depend on each other).

## Backend (cwd `backend/`)

1. Tests: `backend/venv/bin/python -m pytest tests/ -q` (in-memory sqlite;
   no `MISTRAL_API_KEY` needed).
2. Lint: `backend/venv/bin/ruff check .`

## Frontend (cwd `frontend/`)

3. Lint: `pnpm lint`
4. Types: `pnpm typecheck` (`tsc --noEmit`)
5. Tests: `pnpm test` (vitest run)

## Optional `--offline`

If `$ARGUMENTS` contains `--offline`, additionally run the deterministic,
LLM-free matcher oracle:
`backend/venv/bin/python backend/e2e/validate_offline.py`
(requires the LOINC-seeded dev DB at `backend/health_passport.db`; it never
touches port 8000 or spawns a server). Report its mismatch summary too.

## Reporting

- On failures show the first traceback/assertion per failing check with
  `file:line` references, then diagnose root cause (app bug vs test bug).
- Never report "done" with a red check; fix or surface the failure first.
