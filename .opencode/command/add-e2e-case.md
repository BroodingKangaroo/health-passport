---
description: Add a new e2e golden case and review it before committing.
---

# Add an e2e golden case

Add a new standardized-document acceptance case to `backend/e2e/`.

$1 is the intended case name (e.g. `оак_26.05`).

## Steps

1. **`inputs/<case>/`**: place the source document under
   `backend/e2e/inputs/$1/`. If the document is not present yet, tell the user
   where to put it and stop.

2. **Regenerate**: run
   `backend/venv/bin/python backend/e2e/run_e2e_server.py --case $1 --regen-golden`
   from the repo root. The harness writes
   `backend/e2e/golden/$1/standardized.json` as a **FOR-REVIEW** golden.

3. **Review (do not self-approve)**: read the generated golden and the source
   document side-by-side. Cross-check every biomarker's:
   - name + LOINC mapping, unit (incl. `standard_unit` / `canonical_unit_inferred`),
   - `reference` kind/interval vs the source ranges, computed `status`,
   - value conversions (`scale_function`, `needs_review`).
   Extraction is LLM/OCR-based, so the generated golden may be noisy — for a
   deterministic, LLM-free oracle run
   `backend/venv/bin/python backend/e2e/validate_offline.py` and compare.

4. **Record matcher mismatches** in `backend/e2e/KNOWN_ISSUES.md` rather than
   silently editing the golden to force a pass.

5. **Report, never commit**: present the review to the user, flag anything
   pending/unreviewed, and give them the report — do **not** run `git add` /
   `git commit` yourself. Wait for explicit approval.

If `$ARGUMENTS` includes extra flags (e.g. `--url-token <jwt>`), pass them
through to the harness in step 2.