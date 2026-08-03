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
  run_delete_e2e.py     # boots an ISOLATED server and runs a full HTTP round-trip test of DELETE /api/entry/{id}
  compare.py            # tolerant comparison rules
  validate_offline.py   # deterministic matcher-only validation (skips OCR+LLM)
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

**Server rule (IMPORTANT):** the harness targets a *live* server; it does NOT
start or stop one. Never `pkill -f "uvicorn app.main:app"` — that kills any
server the user already has running (typically on port 8000). Always use
`run_e2e_server.py` (isolated port, default 8099; never 8000) or
`run_delete_e2e.py` (port 8098) which tear down only their own PID.

```bash
python backend/e2e/run_e2e_server.py                 # all cases
python backend/e2e/run_e2e_server.py --case оак_26.05  # one case
```

## Known flakiness

Extraction is LLM/OCR-based, so results vary run-to-run. Also, a single failed
image extraction can contaminate later requests *in the same process* (returns
`unknown`/empty) until the server is restarted — this is a pre-existing bug,
not a definition-seeding issue. The deterministic, LLM-free oracle is
`python backend/e2e/validate_offline.py` (uses the LOINC-seeded DB; the
`default` user); prefer it for matcher/data correctness.

## Delete endpoint e2e

`run_delete_e2e.py` is a separate, smaller e2e for the `DELETE /api/entry/{id}`
CRUD path (the golden harness above only covers the AI extraction pipeline).
It boots its own isolated uvicorn on port 8098 with a temp sqlite DB, registers
a fresh user, uploads a real file via `POST /api/entry`, then DELETEs the entry
and asserts the full round trip:

- file lands on disk under `static/uploads/<name>` with the expected byte size
- `GET /api/usage/limits` shows the storage counter increased by exactly the file size
- `GET /api/timeline` contains the new entry
- `DELETE /api/entry/{id}` returns 200 with `freed_bytes` matching the file size
- the file is unlinked from disk
- the entry is gone from `GET /api/timeline`
- the storage counter is back to its baseline
- a second DELETE returns 404

```bash
python backend/e2e/run_delete_e2e.py                # default port 8098
python backend/e2e/run_delete_e2e.py --port 8124   # pick a free port
python backend/e2e/run_delete_e2e.py --keep-artifacts  # keep temp DB+files for debugging
```

The server is always torn down by PID (never a blanket pkill) and the temp
DB is removed on success. Unlike the golden harness, this test does **not**
need `MISTRAL_API_KEY` — it exercises CRUD only.

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
