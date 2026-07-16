# HealthPassport e2e golden harness

A fixture-driven acceptance layer that proves a **real** medical document
(PDF / image of a blood test, doctor visit, or imaging report) is converted
into the **correct** structured `StandardizedMedicalRecord` JSON.

The server (`POST /api/extract`) is the system under test. This folder only
contains a small **HTTP client** that drives the endpoint and diffs its output
against a hand-verified **golden** JSON. It imports no app code, so the matcher
is exercised for real (OCR + extraction + matching all run live on the server).

When the matcher mis-routes an analyte, the produced JSON differs from golden
→ the case fails, surfacing the bug instead of hiding it.

> Fixing the matcher itself (e.g. adding curated RU synonyms, tightening the LLM
> verification backstop) is a **separate** workstream. This harness only
> *surfaces* mismatches into `KNOWN_ISSUES.md`.

## Layout

```
backend/e2e/
  run_e2e.py      # the harness: POST file -> /api/extract -> diff vs golden
  compare.py      # tolerant comparison rules
  README.md
  .gitignore      # ignores your private inputs/ and auto-generated stubs
  inputs/<case>/<file>   # you drop a real PDF/image here (one doc per case)
  golden/<case>/standardized.json   # hand-verified acceptance JSON
  KNOWN_ISSUES.md
```

A **case** is a subdirectory of `inputs/` named after the document
(e.g. `inputs/russian_cbc_pdf/`). The case name links the input to its golden
(`golden/russian_cbc_pdf/standardized.json`).

## 1. Start the server (system under test)

From `backend/`, with the virtualenv activated:

```bash
# One-time (or after reseeding): load the FULL LOINC dictionary so the matcher
# can route the full set of analytes (RDW, Активированные лимфоциты, ...).
python -m app.db.seed_loinc

# Start the API. MISTRAL_API_KEY must be set so OCR+extraction+matching run.
export MISTRAL_API_KEY=...
uvicorn app.main:app --port 8000
```

> **Why seed the full dictionary?** The default server startup (`init_db` →
> `seed_db`) only seeds 18 `BIOMARKER_DEFINITIONS`. For realistic acceptance you
> want the full LOINC dictionary, which requires `python -m app.db.seed_loinc`.
> Keep the server's dictionary stable while a golden is in use, otherwise the
> expected mappings can drift.

## 2. Add a case

```bash
mkdir -p backend/e2e/inputs/<my_case>
cp /path/to/real_document.pdf backend/e2e/inputs/<my_case>/
```

## 3. Generate a review copy of the golden

Run the harness with `--regen-golden`. It calls the endpoint, then writes the
observed output to `golden/<my_case>/standardized.json` marked
`"FOR REVIEW - not auto-accepted"`.

```bash
python backend/e2e/run_e2e.py --regen-golden
```

Open the file, verify each biomarker's `standard_name_en` / `definition_id` /
`standard_unit` / `scope` is clinically correct, fix anything wrong, and remove
the `_status` line (or set it to something other than the review marker). Only
commit **verified** goldens.

> Without `--regen-golden`, if no golden exists the harness writes an auto
> `standardized.pending.json` stub and reports the case as `PENDING
> VERIFICATION` (non-failing). This keeps every dropped-in document tracked
> even before a human reviews it.

## 4. Run the acceptance check

```bash
python backend/e2e/run_e2e.py                 # all cases
python backend/e2e/run_e2e.py --case <my_case>   # one case
```

Output shows per-biomarker diffs like:

```
biomarker 'Активированные лимфоциты'[0] standard_name_en: expected 'Activated lymphocytes', got 'Lymphocytes'
biomarker 'Активированные лимфоциты'[0] definition_id: expected '...', got 'lymphocytes'
```

Exit code is **non-zero if any verified golden mismatches** → safe to gate CI.
Pending cases do not fail the run.

### Useful flags

| flag | purpose |
|------|---------|
| `--case <name>` | run a single case |
| `--url <url>`   | override the endpoint URL (default `http://localhost:8000/api/extract`) |
| `--token <jwt>` | authenticate as a registered user (AI limit 5 → 20 extractions) |
| `--regen-golden`| write observed output as a FOR-REVIEW golden |
| `--text-threshold 0.9` | similarity cutoff for free-text fields (default 0.9) |

## Comparison rules (in `compare.py`)

* **biomarkers** — compared as a set keyed by `raw_name`. For each:
  `standard_name_en`, `definition_id`, `standard_unit`, `scope` must match
  **exactly**; `standard_value` allows a `1e-6` float tolerance; `status` is
  recomputed by the server so it is **ignored**; ordering is ignored.
* **visit_data / imaging_data** — deep-compared with normalized whitespace.
  `original` must match exactly (frozen by extraction on the server);
  `translated_en` / `findings` / `conclusion` allow a similarity threshold
  (live translation is non-deterministic).
* **top-level** — `entry_type` exact; `date`/`time` normalized; `clinic`/
  `provider`/`title`/`notes` via similarity threshold.

## Recording mismatches

When a verified golden fails, copy the `biomarker ...` diff lines into
`KNOWN_ISSUES.md` using the template there: `raw_name`, **observed** mapping,
and **expected** analyte. That backlog feeds the matcher-fix workstream.
