# e2e golden harness

A fixture-driven acceptance layer that proves a **real** medical document
(PDF / image of a blood test, doctor visit, or imaging report) is converted
into the **correct** structured `StandardizedMedicalRecord` JSON.

The server (`POST /api/extract`) is the system under test. This folder only
ships a small **HTTP client** that drives the endpoint and diffs its output
against a hand-verified **golden** JSON. It imports no app code, so OCR +
extraction + matching all run live on the server. When the matcher mis-routes
an analyte, the produced JSON differs from golden → the case fails.

## Layout

```
backend/e2e/
  run_e2e.py            # harness: POST file -> /api/extract -> diff vs golden
  run_e2e_server.py     # boots an ISOLATED server on :8099 (+ own DB) and runs the harness
  compare.py            # tolerant comparison rules
  README.md
  inputs/<case>/<file>  # drop a real PDF/image here (one doc per case)
  golden/<case>/standardized.json   # hand-verified acceptance JSON
  KNOWN_ISSUES.md
```

A **case** is a subdirectory of `inputs/` named after the document; its name
links the input to `golden/<case>/standardized.json`.

## Run it (recommended: isolated server)

`run_e2e_server.py` boots its own uvicorn on an isolated port with its own DB,
runs the harness, and tears down only that process. It never touches a port-8000
dev server. First run seeds the LOINC dictionary into its DB.

```bash
python backend/e2e/run_e2e_server.py                 # all cases
python backend/e2e/run_e2e_server.py --case оак_26.05  # one case
```

## Run it (manual server)

```bash
# from backend/, venv active; MISTRAL_API_KEY must be set
python -m app.db.seed_loinc      # load full LOINC dictionary (one-time / after reseed)
export MISTRAL_API_KEY=...
uvicorn app.main:app --port 8000

python backend/e2e/run_e2e.py                 # all cases
python backend/e2e/run_e2e.py --case оак_26.05  # one case
```

Keep the dictionary stable while a golden is in use, or expected mappings drift.

## Add a case / regenerate a golden

```bash
mkdir -p backend/e2e/inputs/<my_case>
cp /path/to/real_document.pdf backend/e2e/inputs/<my_case>/

python backend/e2e/run_e2e_server.py --case <my_case> --regen-golden
```

`--regen-golden` writes observed output as a `FOR REVIEW` golden. Verify each
biomarker's `standard_name_en` / `definition_id` / `standard_unit` / `scope`,
then remove the `_status` line. Commit **only verified** goldens.

Without `--regen-golden`, a missing golden is written as
`standardized.pending.json` and reported `PENDING` (non-failing).

## Useful flags

| flag | purpose |
|------|---------|
| `--case <name>` | run a single case |
| `--url <url>`   | override endpoint URL (default `http://localhost:8000/api/extract`) |
| `--token <jwt>` | authenticate as a registered user (AI limit 5 → 20) |
| `--regen-golden`| write observed output as a FOR-REVIEW golden |
| `--dump-observed <path>` | write the raw observed JSON (debug) |
| `--text-threshold 0.9` | similarity cutoff for free-text fields (default 0.88) |

Exit code is **non-zero if any verified golden mismatches** → safe to gate CI.
Pending cases do not fail the run.

## Comparison rules (`compare.py`)

* **biomarkers** — compared as a set keyed by `raw_name`. `standard_name_en`,
  `definition_id`, `standard_unit`, `scope` must match **exactly**;
  `standard_value` allows a `1e-6` float tolerance; `status` is recomputed by the
  server so it is **ignored**; ordering is ignored.
* **visit_data / imaging_data** — deep-compared. `original` must match exactly
  (frozen on the server); `translated_en` / `findings` / `conclusion` allow a
  similarity threshold (live translation is non-deterministic).
* **top-level** — `entry_type` exact; `date`/`time` normalized; `clinic`/
  `provider`/`title`/`notes` via similarity threshold.
