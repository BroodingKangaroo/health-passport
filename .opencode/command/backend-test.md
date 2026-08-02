---
description: Run the backend pytest suite against the local venv.
---

Run the backend test suite for HealthPassport:

1. From the repo root, run `backend/venv/bin/python -m pytest tests/ -v` with the
   working directory set to `backend/`. Override cwd with `cd backend && ...`
   only if that is safer for the current shell — prefer the `workdir`
   parameter of the bash tool instead.
2. The suite uses in-memory sqlite via `tests/conftest.py`; no DB setup or
   MISTRAL_API_KEY is required.
3. Report pass/fail per test, and on failures show the first traceback with
   `file:line` references.

If $ARGUMENTS is provided, append it to the pytest invocation
(e.g. `-k some_test` to filter).