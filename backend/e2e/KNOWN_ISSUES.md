# Known Issues

Golden mismatches that were surfaced by the e2e harness and have since been
**fixed** in the matcher / data layer. Recorded here for traceability.

All reviewed mismatches are resolved; both seeded cases
(`биохимия_26.05`, `оак_26.05`) now PASS end-to-end against the live server.

## Scope note: local vs global

- **Активированные лимфоциты** is intentionally `scope=local`. There is no
  standard LOINC for "Activated lymphocytes", so it stays a user/local definition
  (the app UI labels any `scope=local` analyte as "Unrecognized — not in global
  dictionary"). This is correct and expected; the standardized `standard_name_en`
  ("Activated lymphocytes, %") and stable `definition_id`
  (`local-activated-lymphocytes`) are still emitted.
- **RDW** is a real global analyte and is now matched to LOINC **30366-4**
  (`RBC distribution width`, %). It was previously a local stub only because the
  shipped `Loinc.csv` lacks the RDW-CV code; it is now seeded as a global
  definition (see below).

## Fixes applied

1. **µmol/L micro sign** (`Билирубин общий`, `Креатинин`, `Мочевая кислота`)
   - `app/services/converters.py`: mapped `мкмоль/л` → `µmol/L` (micro sign) and
     `мкмоль/сут` → `µmol/d` instead of the ASCII `u`.

2. **Comma before `%` for differential fraction analytes** (`Lymphocytes, %`,
   `Monocytes, %`, `Variant lymphocytes, %`, …)
   - `app/services/matcher.py` `_prefer_comma_pct()`: the comma is applied at
     *output* time (display convention only). The stored definition name keeps
     `X %` so fuzzy matching and the `%`→fraction re-route (`_fraction_variant`)
     stay stable.

3. **Атипичные мононуклеары → Variant lymphocytes (13046-8)**
   - `data/multilingual_synonyms.json`: added `"Атипичные мононуклеары": "13046-8"`.
   - `data/loinc_name_overrides.json`: `"13046-8": "Variant lymphocytes, %"`
     (display name). Removed the `13046-8 -> 735-1` redirect from
     `data/loinc_aliases.json` so the curated code resolves to itself.

4. **Активированные лимфоциты → local `Activated lymphocytes, %`**
   - `app/mock_db.py`: added a local (non-LOINC) definition
     `local-activated-lymphocytes` (stable id, scope `local`).
   - `data/multilingual_synonyms.json`: `"Активированные лимфоциты":
     "local-activated-lymphocytes"`.
   - `app/services/matcher.py`: curated multilingual matches are now excluded
     from the non-deterministic LLM verification backstop, so this high-confidence
     mapping can never be overridden by a loose LLM correction.

5. **Missing curated synonyms** (immature-cell differentials, ALT/AST/GGT/IgE,
   absolute-count variants) — added to `data/multilingual_synonyms.json` so every
   raw name on the two documents resolves deterministically at step 1a, e.g.
   `АлАТ`/`АсАТ`/`Гамма-ГТ`/`Ig E (total)`/`Миелоциты`/`Бласты`/… and the
   `…, абс.` absolute forms.

6. **RDW → global `RBC distribution width` (30366-4)**
   - `app/mock_db.py`: added a global definition for RDW-CV (`loinc_code`
     `30366-4`, name `RBC distribution width`, unit `%`). The shipped `Loinc.csv`
     only contains the SD form (21000-5 / fL), so this CV code is seeded directly.
   - `data/multilingual_synonyms.json`: `"RDW": "30366-4"`,
     `"RDW (шир. распред. эритр)": "30366-4"`,
     `"Ширина распределения эритроцитов": "30366-4"`.
   - `e2e/golden/оак_26.05/standardized.json`: RDW entry updated from the local
     stub to the global match (`definition_id` `30366-4`, `scope` `global`).

## Supporting changes

- `app/services/matcher.py`: `definition_id` in the standardized output is now
  `defn.loinc_code or defn.id` (previously `defn.id`), aligning the emitted id
  with the LOINC code used by the golden for global definitions.
- `app/mock_db.py`: baseline `wbc`/`rbc` display names changed from `WBC`/`RBC`
  to `Leukocytes`/`Erythrocytes` (abbreviations retained as synonyms) so the
  standardized English name matches the golden.

## Notes / non-determinism

- The live extraction (`/api/extract`) relies on the Mistral LLM for OCR and
  structured extraction; `provider`/`notes` text can vary between runs. Both
  cases passed on a representative run. `e2e/validate_offline.py` exercises the
  deterministic matcher path (no live LLM) and is useful for matcher-only
  regression checks.
- The matcher promotes LOINC definitions from `data/Loinc.csv` on first demand and
  persists them; after seeding/resetting the DB the first live run re-promotes
  them. This is expected.
