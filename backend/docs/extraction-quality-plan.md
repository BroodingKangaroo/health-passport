# Extraction Quality — Plan (2026-09-12)

Follow-up to the autoresearch session merged to `main` at `17c6351`.
Baseline facts at hand-off: corpus covers all 10 e2e goldens (helix_2023 added);
final primary **0.8471** (baseline_v9 0.7572 → iter1–5 kept); helix_2023
recognition 0.578 → 0.823; паразиты 1.0/1.0; `validate_offline` 87 diffs / 4
cases (improved from 106/4). Kept loop changes: anti- prefix preservation
(`ef3962d`), literal visit translation (`23c3c8b`), recommendation
completeness retry (`2919484`), native-format units/bands/P-LCR (`d7ab86d`),
prefix casing (`17c6351`).

---

## 1. Data curation — human, off-limits to the loop (highest immediate impact)

Measured: ~+0.085 helix_2023 recognition (≈3 rows) plus P-LCR display naming.
The seeded DB does not contain `2085-9`, `2089-1`, `21000-5`, `22664-7` until
curated, and fuzzy matching currently folds MPV→777-3, HDL/LDL→2093-3,
RDW-SD→788-0.

Changes (KNOWN_ISSUES "Pending system work — helix_2023", items 1/2/7):

- `backend/data/multilingual_synonyms.json` (ru):
  - `ЛПВП-холестерин (HDL)` → `2085-9`
  - `ЛПНП-холестерин (LDL)` → `2089-1`
  - `Средний объем тромбоцитов (MPV)` → `32623-1`
  - `Ширина распределения эритроцитов (RDW-SD)` → `21000-5`
  - `Мочевина`: change `3094-0` → `22664-7` (Urea, mmol/L; NOT BUN)
- `backend/data/loinc_name_overrides.json`:
  - `2085-9` → `"Cholesterol in HDL"`
  - `2089-1` → `"Cholesterol in LDL"`
  - `32623-1` → `"Mean platelet volume"`
  - `21000-5` → `"RBC distribution width (RDW-SD)"`
- Check `backend/data/loinc_aliases.json`: without the `loinc_name_overrides`
  entries the alias redirect folds 2085-9/2089-1 into 2093-3 (the original
  collision). Keep the overrides in place.

Validation:
- Backend dev DB: re-run `python -m app.db.seed_loinc` (drops/recreates the DB
  — dev-only; back up if needed).
- Benchmark: no manual step — `benchmark_seed.db` auto-invalidates because the
  data files are in the snapshot-input fingerprint.
- Quick probe: `cd backend && venv/bin/python benchmark/run_benchmark.py
  --jobs 1 --runs 1 --cases helix_2023 --dump-observed <dir>` and confirm
  `ЛПВП/ЛПНП/Мочевина/MPV/RDW-SD` resolve to the target codes.
- Then full re-baseline: `--runs 3 --report reports/baseline_v10.json`.

## 2. F6 — corpus growth + validation split (human)

The metric is noise-bound again (~0.85; the last two keeps needed clean-rerun
decisions through flaps). Add 8–12 hand-verified cases targeting known
weaknesses, per `ISSUES.md` F6:

- time-of-collection documents (the documented time-drop)
- handwritten / photographed reports
- multi-page PDFs with split tables
- instrumental free-text findings
- rare / ratio / qualitative analytes
- mixed RU/EN documents
- reference ranges in footnotes

Assign `split: validation` to ~30% of the grown corpus **before** ever
screening them. Per-case acceptance: `--runs 1 --cases <new>` clean
(pollution 0), matcher-only deterministic on the guard DB, golden verified via
the e2e-golden workflow, expected metric range in the manifest.

Current gap: all 10 cases are `split: tuning`; the hold-out is empty
(helix_2023 joined as tuning on user direction).

## 3. F15 — objective redesign (deferred; now clearly needed)

The primary-only keep rule cannot keep doc_fidelity/metadata improvements and
discards proven target fixes when unrelated cases flap (iter4's first sample
was +0.0158, within ε, decided only by a confirmation rerun). Proposed
(`ISSUES.md` F15):

- noise-aware keep: bootstrap/CI over per-run recognition, and/or relative ε
  scaled to remaining headroom;
- cost-aware keep path: quality non-inferior within CI + token/wall win ≥ X%;
- per-case non-regression gate so one improved case can't mask a regression.

Touch points: `.opencode/skills/autoresearch/SKILL.md` keep rule,
`backend/benchmark/README.md`, `backend/benchmark/compare_reports.py`.

## 4. Demographics-aware stratified reference bands (product feature)

helix needs patient sex/age for HDL (male `{1.45, null}`), glucose (<60
`{4.11, 5.89}`) and bilirubin (adult `{null, 21}`). None are extracted today.

- extract patient sex + age/birth date (raw schema + extraction prompt);
- pass them to the matcher and select the applicable band;
- then remove the age/sex skip in `matcher/reference_bands.py`.

Value: every real lab document with age/sex-banded ranges, not just helix.

## 5. Next in-scope loop work (once 1–3 exist)

- **Qualifier-aware fuzzy guard** (`matcher/name_matching.py`): never fold a
  more specific name onto a generic def (MPV→Platelets, HDL/LDL→Cholesterol,
  RDW-SD→RDW-CV). Must not regress benign qualifiers ("Total bilirubin" →
  "Bilirubin"); a candidate is rejected when the query carries identity-bearing
  variant tokens the candidate lacks.
- **Deterministic unit map expansion** (`matcher/units_guess.py`): add
  `кл/100 лейк.` → `cells/100 leukocytes` (оак_26.05 Нормобласты), and more
  localized haematology forms.
- **Generalize banded references** (`matcher/reference_bands.py`): labeled
  bands (оптимальный/отрицательный), titer/grey-zone cutoffs, bounded-value
  operator semantics (KNOWN_ISSUES item 10 — schema work needed for the
  operator).
- **Extraction metadata prompt** (`extractor.py`): provider is DONE
  (`6deb805`: signing clinician, never the patient header) — remaining:
  test profile → notes, document title on INVITRO labs, full СОЭ raw name.
  Primary-neutral today; keepable only under F15.
- **OCR variance experiments**: A/B `OCR_MARKDOWN_CLEAN=0/1`, table
  normalization; document-level self-consistency retry for the bimodal
  рнпц/оак translator/OCR flapping.

## 6. Operational notes

- Loop resume protocol (F14): recreate `autoresearch/extraction` from the new
  `main` before any iteration; never rebase over user branches.
- After section 1–2 changes: `--manifest` refresh, then a fresh `--runs 3`
  baseline before measuring iterations.
- `main` is 10 commits ahead of `origin/main` (including this hand-off) and has
  NOT been pushed.

---

## Status — implemented 2026-09-12 (follow-up session)

- **§1 data curation** — done: RU synonyms + overrides for 2085-9/2089-1/
  32623-1/21000-5/22664-7; the seeder now always keeps curated codes (rank-0
  and non-common CLASS) and curated overrides anchor dedupe. Probe: helix_2023
  recognition 0.872 (iter5 0.823); v10 full baseline below.
- **§2 corpus growth** — 3 hand-reviewed cases added (`анализ_мочи_30.07` =
  validation split, `helix_2023_2`, `2024_вирусы`); goldens accepted as
  target truth after `golden-review`; tracked gaps in `e2e/KNOWN_ISSUES.md`.
  The user supplied 3 documents, so the hold-out is 1/13 (~8%) — more cases
  still needed for the plan's 30% target.
- **§3 F15 objective redesign** — done: relative ε (25% of headroom, floor
  0.002), bootstrap recognition CI, cost keep path (≥25% token/wall win),
  majority-run per-case non-regression gate (`benchmark/compare_reports.py`,
  SKILL.md, benchmark README).
- **Out of plan but required by the case review** — specimen-aware matching
  (record/row `specimen`, `data/specimen_synonyms.json`, LOINC-SYSTEM guard,
  urine/feces local qualifiers) plus the review-driven fixes: no fabricated
  dates, `<0,5` comma bounds, plural `не обнаружены`, balanced parens, blood
  `visit_data` clearing, IgG carrier guard, mutation-name canonicalization,
  `в п/зр.` → `/[HPF]`.
- **v10 baseline** (13 cases, `--runs 3`, clean): primary **0.8655**,
  recognition 0.9294, stability 0.9313, doc_fidelity 0.8199; offline guard
  148 diffs / 7 cases (see KNOWN_ISSUES for the offline specimen limitation).
- **Evening session (2026-09-12, branch `autoresearch/extraction`)**: provider
  fix `6deb805`; iter1 `4491be6` (instrumental visit_data/findings hygiene)
  and iter2 `3b9d096` (qualitative reference duplication) both KEPT under F15;
  clean baseline_v11 **0.7837** -> **0.8546** after iter2 on the 13-case
  corpus. RDW-CV curated (`788-0`). Loop then hit the documented plateau:
  remaining helix rows are data/demographics/product-gated, in-scope safe
  hypotheses exhausted (see `.autoresearch/autoresearch.md`).

