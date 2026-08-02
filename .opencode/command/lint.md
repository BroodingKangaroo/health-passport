---
description: Run frontend and/or backend lint.
---

# Lint HealthPass

- Frontend: `pnpm lint` in `frontend/` (eslint). Auto-fix trivial issues.
- Backend: there is **no configured backend linter** in this repo (no ruff /
  flake8 in the venv or pyproject). Skip it — do not invent one.

If $ARGUMENTS is not empty, only run the given target (`frontend`, `backend`
is a no-op). Report remaining issues with `file:line` references.