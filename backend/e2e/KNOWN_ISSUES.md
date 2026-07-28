# Known Issues

Golden mismatches surfaced by the e2e harness and **fixed** in the matcher /
data layer, kept for traceability.

**Status:** all five seeded cases
(`биохимия_26.05`, `оак_26.05`, `гастроэнтеролог_ргц_29.06`,
`рнпц_омр_генетика`, `колонофлор_16_25.06`) PASS against the live server.

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

4. **Parser now understands scientific notation, Russian decimal comma, and
   bounded Russian ranges** (root cause of the `колонофлор_16_25.06` golden).
   `app/services/reference.py`:

   - `parse_value` recognises ``N*10^K`` / ``N×10^K`` / ``N·10^K`` / ``Nx10^K``
     (``9*10^7`` → 9e7), the bare exponent form ``N^K`` (``10^10`` → 1e10 —
     mathematical exponentiation, NOT ``N * 10**K`` which would give 1e11),
     Russian comma decimals (``8,75`` → 8.75), and bounded forms
     (``< N`` / ``> N`` / ``≤ N`` / ``≥ N`` / ``менее N`` / ``более N`` /
     ``не более N`` / ``не менее N``).
   - `parse_reference` recognises all of the above as well as two-sided
     ranges (``N1 - N2`` with scientific notation / Russian comma / en/em
     dash on either side) and the "any amount allowed" form
     ``допустимо любое количество`` / ``любое количество`` → unbounded
     interval `{low: null, high: null}`.

5. **Quantitative biomarkers keep their numeric `standard_value`** (the
   `колонофлор_16_25.06` golden is the regression test). Prior to this fix,
   `_build_standardized_local` always called `normalize_qual(parse_value(...))`
   on the raw value, which collapsed a numeric result like ``10^10`` → 10.0
   into the qualitative string ``"Present"``. Now the local path mirrors the
   Quantitative / Qualitative split:
   - if the parsed `raw_range_string` is an `interval`, the value stays a
     number (`parse_value(...)`) and only string values are canonicalised
     (e.g. ``не обнаружено`` → ``Not detected``);
   - if the parsed ref is `qualitative`, the value is always canonicalised
     (preserves the previous behavior, including the оак_26.05
     ``Активированные лимфоциты`` ``0`` → ``Absent`` case).
   The same split is applied in `_fallback_standardize`. `_build_standardized_from_def`
   already canonicalised string values, so the only change there is to
   canonicalise them regardless of ref kind (so an interval ref with a
   ``Not detected`` value stays in canonical form).

6. **`standard_value` type matches the reference kind.** A canonical
   "absent" result (``Not detected`` / ``Negative`` / ``Absent`` / ``Normal``)
   paired with an `interval` reference now becomes `0.0` so the value
   composes with the interval bounds in `compute_status`. A canonical
   "present" result (``Positive`` / ``Present`` / ``Detected`` /
   ``Abnormal``) against an interval ref has no known count and is kept as
   the canonical string. Qualitative refs keep canonicalising the value
   (including ``0`` → ``Absent`` for the оак_26.05
   ``Активированные лимфоциты`` case). Applied in
   `_build_standardized_from_def`, `_build_standardized_local`, and
   `_fallback_standardize`.

## Notes

- Live extraction depends on the Mistral LLM; free-text (`title` / `provider` /
  `notes` / `recommendations`) can vary run-to-run (similarity-thresholded).
  The `колонофлор_16_25.06` `title` field is particularly noisy — the LLM
  sometimes returns just the short test name (`КОЛОНОФЛОР-16 [реал-тайм ПЦР]`)
  and sometimes the full section header
  (`Исследование состава микробиоты толстого кишечника… КОЛОНОФЛОР-16 [реал-тайм ПЦР]`).
  Rerun `run_e2e_server.py` if a transient degraded extraction occurs.
- LOINC defs are promoted from `data/Loinc.csv` on first demand and persisted.
- `app/mock_db.py` is **not** part of the server data path — the server seeds
  from `Loinc.csv` via `seed_loinc`. Edits there have no effect.
