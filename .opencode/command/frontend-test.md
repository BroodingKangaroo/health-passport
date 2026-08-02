---
description: Run the frontend unit tests (vitest) in the frontend app.
---

Run the frontend unit tests for HealthPassport.

1. From the repo root run `pnpm test` with the working directory set to `frontend/`
   (use the bash tool `workdir` parameter).
2. vitest runs in a jsdom env; the `@/` alias resolves to `src/`.
3. Report failures with the relevant file, line, and assertion message, and
   diagnose whether the failure is a test bug or an app regression.

If $ARGUMENTS is provided, pass it through to vitest (e.g. a file filter).