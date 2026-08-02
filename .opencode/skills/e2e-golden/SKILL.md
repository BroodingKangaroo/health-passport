---
name: e2e-golden
description: Use when adding a case to backend/e2e/, regenerating/verifying a golden standardized.json, or working with the golden harness (run via run_e2e_server.py, add-e2e-case, KNOWN_ISSUES.md). Covers the add-case workflow, golden review, and the no-pkill/no-port-8000 safety rules.
---

# HealthPass e2e golden harness

Covers the acceptance-harness workflow for `backend/e2e/` and its safety
rules.

## When to use

- User adds a new case: "add a case for <doc>", "regen golden", "e2e case".
- User wants to add an e2e document, evaluate a failed extraction, or reasons
  about `standardized.json` / `KNOWN_ISSUES.md`.

## Architecture

- Harness script: `backend/e2e/run_e2e.py` — a **pure HTTP client** (`POST
  /api/extract`), diffs output against the golden file. It does NOT start a
  server. Case inputs live in `backend/e2e/inputs/<case>/`, verified outputs
  in `backend/e2e/golden/<case>/standardized.json`.
- **Server rule (safer)**: never `pkill -f "uvicorn app.main:app"` and never
  target port 8000 (that's the user's dev server). Boot an isolated server
  instead with `backend/venv/bin/python backend/e2e/run_e2e_server.py`
  (default port 8099, own DB `e2e_run.db`, LOINC-seeded on first run), and
  kill only that PID.
- **Deterministic, LLM-free oracle**: `backend/venv/bin/python
  backend/e2e/validate_offline.py` — prefer it for matcher/data correctness
  (extraction is LLM/OCR-based and varies run-to-run).
- `KNOWN_ISSUES.md` records known matcher mismatches; verified goldens gate CI.

## Add-a-case workflow

1. Drop the raw document into `backend/e2e/inputs/<case>/`.
2. Regenerate with `--regen-golden` (never auto): e.g.
   `backend/venv/bin/python backend/e2e/run_e2e_server.py --case <case> --regen-golden`.
3. Review the output golden (`golden/<case>/standardized.json`) with the
   `golden-review` agent — never self-approve. Check each biomarker's LOINC
   mapping, unit (incl. `lg`=log10), `reference` interval/status, and
   `scale_function`/`needs_review`.
4. Record any matcher mismatches in `KNOWN_ISSUES.md` instead of editing the
   golden to pass.
5. Report results. **Never** `git add`/`git commit` yourself — wait for
   explicit user approval; unverified goldens stay pending and don't fail CI.

## Verification smoke

- Quick smoke run without regeneration:
  `backend/venv/bin/python backend/e2e/run_e2e_server.py --case <case>`
  (exits non-zero only on verified-golden mismatch).
- After regen, prefer `validate_offline.py` for deterministic comparison.