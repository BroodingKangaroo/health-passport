---
description: Run the e2e golden harness against an isolated backend server.
---

Run the HealthPass e2e golden harness safely.

- Boot an isolated backend with `backend/venv/bin/python backend/e2e/run_e2e_server.py`
  from the repo root. It spawns its own uvicorn on port **8099** with its own
  DB (`e2e_run.db`), runs the harness, and tears down only that process by PID.
- **NEVER** use `pkill -f "uvicorn app.main:app"` and **never** target port
  8000 — that kills any dev server the user already has running.
- This invokes real `/api/extract` (LLM/OCR), so it requires `MISTRAL_API_KEY`
  and a LOINC-seeded DB (the isolated server seeds on first run).
- Output is non-zero only on verified-golden mismatch; pending/unreviewed
  goldens are reported but don't fail.
- Known flakiness: LLM/OCR output varies run-to-run. If results look wrong,
  prefer the LLM-free oracle `backend/venv/bin/python backend/e2e/validate_offline.py`
  for matcher/data correctness.

Pass $ARGUMENTS through to `run_e2e_server.py` (e.g. `--case <name>`,
`--regen-golden`, `--port`, `--db`). Do **not** pass `--regen-golden` unless
the user explicitly asked to regenerate goldens.