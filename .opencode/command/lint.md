---
description: Run frontend and/or backend lint.
---

# Lint HealthPass

- Frontend: `pnpm lint` in `frontend/` (eslint). Auto-fix trivial issues.
- Backend: `backend/venv/bin/ruff check .` from the repo root (config in
  `backend/pyproject.toml`). Auto-fix trivial issues with
  `backend/venv/bin/ruff check --fix .`.

If $ARGUMENTS is not empty, only run the given target (`frontend`, `backend`
is a no-op). Report remaining issues with `file:line` references.