# Known Issues

Golden mismatches surfaced by the e2e harness and **fixed** in the matcher /
data layer, kept for traceability.

**Status:** all four seeded cases
(`биохимия_26.05`, `оак_26.05`, `гастроэнтеролог_ргц_29.06`,
`рнпц_омр_генетика`) PASS against the live server.

## Local vs global scope

- **`Активированные лимфоциты`** is intentionally `scope=local` (per-user). There
  is no LOINC for "Activated lymphocytes", so it resolves to a per-user local
  definition (UI labels `scope=local` as "Unrecognized"). Its curated synonym
  points at the sentinel `local-activated-lymphocytes`; the matcher treats that
  as a local-only signal and never merges it into `Lymphocytes` (26474-7).
- **RDW** is a real global analyte. The RDW-CV code in the shipped `Loinc.csv` is
  **`788-0`** (`RBC distribution width`, %). `30366-4` is NOT in the dictionary
  (it was an artifact of the unused `app/mock_db.py`).

## Fixes

1. **Matcher crash → empty `definition_id`** (root cause of the `оак_26.05`
   77-diff failure). `_is_fraction_def()` did
   `bool((defn.names or {}).get("en","")).endswith("%")` — `bool(...)` returns a
   `bool`, so `.endswith` raised `AttributeError`, `match_and_convert` fell back
   to `_fallback_standardize`, and every biomarker lost its `definition_id`.
   Fixed to `isinstance(en, str) and en.endswith("%")`. Only surfaced when a
   biomarker is unmatched (Step 2) while LLM translation fails.

2. **Curated `local-` synonyms are honored.** A curated code starting with
   `local-` (e.g. `Активированные лимфоциты`) is excluded from global LOINC
   lookup and from the LLM zero-shot guess, so it can never be promoted to a
   global LOINC. See `app/services/matcher.py` Step 1a / Step 2.

3. **RDW → `788-0`** (`RBC distribution width`). `data/multilingual_synonyms.json`
   points `RDW` / `RDW (шир. распред. эритр)` / `Ширина распределения эритроцитов`
   to `788-0`; `data/loinc_name_overrides.json` sets its display name.

## Notes

- Live extraction depends on the Mistral LLM; free-text (`provider` / `notes` /
  `recommendations`) can vary run-to-run (similarity-thresholded). Rerun
  `run_e2e_server.py` if a transient degraded extraction occurs.
- LOINC defs are promoted from `data/Loinc.csv` on first demand and persisted.
- `app/mock_db.py` is **not** part of the server data path — the server seeds
  from `Loinc.csv` via `seed_loinc`. Edits there have no effect.
