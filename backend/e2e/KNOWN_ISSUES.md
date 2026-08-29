# Known Issues

Golden mismatches surfaced by the e2e harness and **fixed** in the matcher /
data layer, kept for traceability.

**Status:** all seven seeded cases
(`биохимия_26.05`, `оак_26.05`, `гастроэнтеролог_ргц_29.06`,
`рнпц_омр_генетика`, `колонофлор_16_25.06`, `колонофлор_16_13.05`,
`эластометрия_печени`) PLUS `популяции_лимфоцитов_анализ` (fix #10) and
`паразиты_1` (fix #9, offline only) are handled below; goldens verified &
committed.

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
    global LOINC. See `app/services/matcher/pipeline.py` Step 1a / Step 2.

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

7. **Russian abbreviations for "not detected" are recognised.** The lab
   sometimes prints ``не обнар`` (truncated ``не обнаружено``) or
   ``не выявл`` / ``не обнаруж`` (other shortenings). All map to the
   canonical ``Not detected`` in `app/services/reference.py:_QUAL_MAP` so
   the matcher can collapse them to `0.0` for interval refs and match the
   ``Not detected`` expected text for qualitative refs. Regression test:
   `колонофлор_16_13.05`.

8. **Local def ids are stable across cosmetic name variants.** OCR /
   LLM extraction can produce minor cosmetic differences in the same
   biomarker name across documents (e.g. ``Bifidobacterium spp`` vs.
   ``Bifidobacterium spp.``, with or without a trailing period, or
   ``Мутация в гене CALR (9 exon)`` vs. ``Мутация в гене CALR (9 exon)``
   with / without a trailing parenthesis). Previously the matcher hashed
   the raw name verbatim, so the two variants created two separate
   local definitions (e.g. a `Bifidobacterium spp` def with empty unit
   and a `Bifidobacterium spp.` def with the new unit, even though
   they're the same analyte). Now the matcher hashes
   `_normalize_name(raw_name)` (trailing OCR punctuation stripped + case
   folded) in both `verify_or_create` and `_make_local_copy`, so
   ``Bifidobacterium spp`` and ``Bifidobacterium spp.`` collapse to the
   same `local-…` id. The original raw form is still kept in `synonyms`
   so a later exact-match by the raw form still works. The English
   display name also has its trailing punctuation stripped (via the
   lighter `_strip_trailing_punct` helper) so the UI never shows a
   trailing dot in the analyte name.

9. **Parasite serology screens resolve to their own analytes** (regression
   case `паразиты_1`). Four fixes from golden review:
   - Compound antibody names no longer fuzzy-collapse onto the bare generic
     `IgG` mass-concentration def (`2465-3`): a carrier-token guard rejects
     fuzzy candidates whose whole name is an immunoglobulin class token
     (`_is_carrier_subset_collision`, `name_matching.py`) when the query has
     additional meaningful words; and `verify_or_create(force_local=True)`
     bypasses BOTH the LLM guess and the global-name/synonym fallback scan,
     so a previously LEARNED global synonym can never resurrect a mapping
     curation deliberately sends local (`pipeline.py` passes the flag for
     curated `local-…` sentinels).
   - Curated mappings: `anti-Toxocara IgG` → serum Presence code `96568-1`,
     `anti-Ascaris IgG` → `74815-2`; Opisthorchis/Lamblia have no dictionary
     code → forced per-user locals via sentinels
     (`local-opisthorchis-igg`, `local-lamblia-immunoglobulins`).
   - Truncated `отрицат.`/`отрицат`/`отриц.` canonicalise to `Negative`
     (`reference.py _QUAL_MAP`, same abbreviation class as fix #7).
   - Qualitative, unitless readings emit `standard_unit: ""`: first-seen
     anchoring forces an empty canonical when value+range carry no digits
     (`definitions.py _is_qualitative_result`), and both standardized build
     paths suppress the reading-level unit guess for unitless qualitative
     rows (`standardize.py`) so serology never shows invented "U/mL".
   The extraction prompt also stops leaking receipt timestamps: time is
   emitted only when printed NEXT TO the collection/visit/exam date.

10. **Lymphocyte flow-cytometry subsets map to their true LOINC codes**
    (regression case `популяции_лимфоцитов_анализ`, golden review found
    NK→Monocytes 5905-5, CD3+/CD19+ % → abs-count 26474-7 with `%` units,
    helpers/NK abs → synovial-fluid Cells 32164-6). Curated multilingual
    entries now pin every subset row (exact raw-name spellings incl. doc
    spacing variants): CD3 8124-0/8122-4, CD19 8117-4/8116-6, CD4 helpers
    8123-2/24467-3, cytotoxic 8101-8/14135-8, NK 8112-5/9728-7, NKT
    42189-1/42188-3, CD4/CD8 index 54218-3 — all `%`/abs pairs split as
    distinct global defs, so the single-canonical-unit invariant holds and
    paired %/abs rows stop flapping between global/local.

11. **Subset display names + unified category taxonomy** (2026-08-27).
    The codes from fix #10 are correct, but their DISPLAY names collapsed to
    generic "Cells"/"Cells, %": `seed_loinc._short_display_name` derives names
    from COMPONENT (`Cells.CD3/Cells`) by dropping unknown "." subparts.
    - Curated fixes: `data/loinc_name_overrides.json` now pins all 13 subset
      codes to patient-friendly names (e.g. 8124-0 → `CD3+ T-lymphocytes, %`,
      54218-3 → `CD4/CD8 ratio`); old short names remain synonyms for recall.
    - Categories: local defs used to inherit whatever heading the extraction
      LLM emitted ("Инфекции", "General", long Russian panel titles), so one
      document showed mixed-language categories (regression case
      `паразиты_1`). `category_normalize.py` gained a deterministic static
      source-heading map (`SOURCE_HEADING_TO_PANEL`: Инфекции→Microbiology,
      microbiome headings→Microbiome, Клинический анализ крови→Complete Blood
      Count, Секвенирование→Genetics), a CELLMARK→Immunology class entry, and
      `LOCAL_PANEL_BY_CODE` pinning curated sentinels
      (`local-opisthorchis-igg`, `local-lamblia-immunoglobulins`) to
      Microbiology; the pipeline forwards each sentinel code into local-def
      creation (`verify_or_create(local_code=…)`).
    - Robustness fix surfaced by reseeding: re-running a doc whose local def
      is still PENDING in the same uncommitted session raised
      UNIQUE(id)-violation; the post-rollback existence lookup could never
      find it (rollback discards the very object). `verify_or_create` now
      early-checks by defn-id before insert (mirrors `_make_local_copy`).
    - Golden `популяции_лимфоцитов_анализ` regenerated live + independent
      golden-review APPROVED (values/refs/status/codes unchanged; only
      names/categories moved); mirrored into `benchmark/corpus/`. This is the only
    case that also reproduces EXACTLY offline (`validate_offline` PASS);
    `паразиты_1` keeps one documented offline diff: the LLM-free path cannot
    translate newly-created local def names, so
    `anti-Opisthorchis IgG`'s `standard_name_en` stays untranslated there.

12. **`рнпц_омр_генетика` golden regenerated after stable translator drift**
    (2026-08-27, independent golden-review APPROVE ×2). The batch translator's
    English phrasing for the four mutation rows moved from `"... gene
    mutation (9 exon"` to `"(exon 9"` word order and stayed there across five
    consecutive live runs, so the old phrasing failed deterministically.
    Category also normalizes to `Genetics` now: extraction can append document
    context to a heading (`Секвенирование (аналитическая чувствительность
    20%)`), which used to leak verbatim past the exact-match map —
    `category_normalize` strips parenthetical/trailing qualifiers before the
    static lookup. The `provider` field settled on the single doctor
    (`Субоч Е.И.`) in all recent runs (previous note called this transient;
    it is now the observed steady state; both-doctor extractions may still
    reappear occasionally). Definitions/ids/values/refs untouched.

13. **Log-scale units never anchor as the canonical unit** (2026-08-29,
    user-directed; `колонофлор_16_13.05` regenerated). A first-seen
    `lg копий/мл` row used to anchor the canonical unit `lg copies/mL`
    (kind `log10`), which meant the 13.05-only bacteria (Blautia,
    Eubacterium rectale, Prevotella, Ruminococcus, Methanobrevibacter,
    Methanosphaera, Acinetobacter, Streptococcus, Roseburia inulinivorans,
    Bacteroides thetaiotaomicron, the Bacteroides/F. prausnitzii ratio)
    permanently displayed log values while the shared rows showed linear
    `copies/mL`. `definitions.py _linearized_anchor` now strips the log
    prefix at anchor time: the canonical lands on `copies/mL` (the `lg`
    prefix still MEANS log10 — the anchoring document's own value/reference
    bounds are scaled `10^x`, and readings printed in the log unit convert
    via the deterministic `10^x` scale function; nothing about the VALUES
    changed). Ratio-like analytes anchor dimensionless `ratio` (a log
    prefix on a ratio row is a table-header artifact — value/ref stay
    unscaled, consistent with the 25.06 sibling). Canonical absent strings
    (`Not detected`) no longer set `needs_review` on a unit mismatch, and a
    unitless (qualitative) def never leaks a raw unit column onto readings —
    which is why BOTH колонофлор goldens' qualitative rows now carry
    `standard_unit: ""` (the legacy `copies/mL` there was a pre-fix-#9
    warm-up pin, not fresh-DB behavior). Existing lg-anchored defs in real
    DBs are converted by `scripts/migrate_lg_to_linear.py` (defs + readings
    + persisted statuses; backs up the sqlite file first). The
    fresh-DB anchor-ORDER dependency below is gone: 13.05-unique defs now
    anchor `copies/mL` even when 13.05 runs first alphabetically.

    Companion fixes shipped in the same change (all golden-review APPROVED
    2026-08-29, 7 files):
    - **Batch unit-translator guard** (`units_guess.py`): mistral-medium
      intermittently returns an EMPTY unit for `lg копий/мл` (violating the
      prompt) or silently DROPS the log prefix; both would corrupt the
      canonical anchor. The batch result now falls back to the deterministic
      identity translation (prefix preserved) and recomputes `kind` from the
      returned unit's own prefix.
    - **Qualitative-suppress refinement** (`standardize.py
      _suppress_unit_for_qualitative`): a deliberately-unitless def
      (`canonical_unit == ""`) shows `""` on every reading regardless of the
      effective reference kind; legacy NULL-canonical defs keep their unit
      fallback unless def.unit AND the raw unit are both empty.
    - **Microbiome heading-family fallback** (`category_normalize.py`):
      qualifier-mangled microbiome headings (and the «Микробиом» family)
      normalize to `Microbiome`; the mistral models leak document banners
      (`Advanced Diagnostics`) or per-group headers into `category` — the
      колонофлор goldens keep the previously-verified heading values.
    - **Forensics junk synonyms cleaned from the dev DB**: the global
      `Ascaris sp Ab` (74815-2) and `Citrulline` (20640-9) defs had learned
      `Salmonella spp` / `Shigella spp` / `Citrobacter spp` synonyms from
      earlier GLM-forensics writes, which hijacked the offline name scan
      (Salmonella → 74815-2 etc.). Removed from `health_passport.db`
      directly (ids above; re-running the offline validator re-proves it).
    - **`warmup_db` pins empty golden units**: a golden row with
      `standard_unit: ""` now pins the def's canonical to `""` (previously
      only non-empty pins applied, leaving stale `copies/mL` anchors).
    - **Offline profile improved to 3 documented diffs** (гастро
      visit-replay trio; was 6, and the pre-change working tree showed 30+).

## Comparator accommodations (2026-08-29, user-approved golden-variance policy)

Stable extraction variants are folded in via comparator tolerance (never by
weakening value gates), mirroring the translated_en_alt precedent:

- `e2e/compare.py` pairs a MISSING golden biomarker with a high-similarity
  (≥0.85) UNEXPECTED observed raw_name (OCR variants: «MCH (ср. содерж. …)»
  vs «MCH (ср. содер. …)»); every other field still must match, so a truly
  mis-routed analyte fails.
- An absent result's two encodings are equivalent: `0.0` + unbounded
  interval ≡ `"Not detected"` + qualitative (the колонофлор
  `B. thetaiotaomicron` OCR cell flake is now encoding-independent — this
  also retires the old ~5/8 pass-rate note for it).
- `title_alt` / `provider_alt` / `modality_alt` (+ any free-text `*_alt`)
  accept stable alternative renderings: the колонофлор title's short/long
  50/50 flip is pinned both ways; рнпц's provider carries both doctors;
  an ultrasound-based elastography may land on `Elastography` or
  `Ultrasound`.
- `time` skips when the OBSERVED side is empty (the extraction prompt
  explicitly permits omitting it; mistral-medium drops it on биохимия/оак
  consistently). A wrong time still fails, the date stays exact, and the
  goldens keep the verified times so a future prompt fix is still validated.

## Notes

- **Offline validator environment (fresh seeds)**: `validate_offline.py` never
  commits, so on a freshly seeded DB it cannot rebuild the per-user local
  anchors (English display names, canonical `copies/mL` units) that
  historical live extractions had committed — its diff counts
  then drift for environment reasons, not matcher reasons. After any
  reseed, run once:
  `PYTHONPATH=. venv/bin/python -m e2e.warmup_db`
  (from `backend/`; deterministic golden replay with commit, колонофлор_16_25.06
  anchored first per the convention below, plus golden-truth unit/name
  pinning of the user-default locals). The post-reseed + warm-up offline
  profile is 6 documented diffs (`гастроэнтеролог` visit-translation 3,
  `эластометрия_печени` instrumental pass-through 3); `паразиты_1`,
  `колонофлор_*`, `рнпц_омр_генетика`, `популяции_лимфоцитов_анализ`,
  `оак_26.05`, `биохимия_26.05` all PASS.
- Live extraction depends on the Mistral LLM; free-text (`title` / `provider` /
  `notes` / `recommendations`) can vary run-to-run (similarity-thresholded).
  The `колонофлор_16_*` `title` field is particularly noisy — the LLM
  sometimes returns just the short test name (`КОЛОНОФЛОР-16 [реал-тайм ПЦР]`)
  and sometimes the full section header
  (`Исследование состава микробиоты толстого кишечника… КОЛОНОФЛОР-16 [реал-тайм ПЦР]`).
  The `колонофлор_16_25.06` ratio biomarker's `standard_name_en` is also
  50/50 between two phrasings. Rerun `run_e2e_server.py` if a transient
  degraded extraction occurs.
- `эластометрия_печени` is the first `instrumental_test` case (type renamed
  from `imaging`, key `instrumental_data`). The extractor prompt (2026-08-03)
  now constrains `instrumental_data.modality` to the fixed UI option set
  (MRI, CT, X-Ray, Ultrasound, Elastography, Mammography, PET Scan, ECG,
  Endoscopy, Other — mirrored from `InstrumentalTestForm.tsx`) and requires
  `notes` to stay empty for instrumental reports (content goes into
  `findings`/`conclusion`). Golden regenerated with `modality: Elastography`,
  `notes: ""`. The comparator still applies a similarity threshold to
  `modality` (harmless: exact matches score 1.0, different modalities score
  low). The case can still flake on the incidental
  `visit_data.recommendations[0].translated_en` live translation (short
  phrases score low on similarity); rerun `run_e2e_server.py` if a run picks
  a paraphrased translation.
- **Blood-test date semantics (2026-08-03)**: the extractor prompt now
  prefers the date when the blood/biomaterial sample was taken (collection
  date), falling back to the report/results date only when no collection date
  is shown. Time is emitted only when shown next to that same
  collection/visit/exam date. Goldens corrected to collection dates:
  `колонофлор_16_13.05` `2026-05-13` (was `2026-05-16 13:11` — results
  stamp), `колонофлор_16_25.06` `2026-06-25 11:16` (was `2026-06-29 01:15`),
  `рнпц_омр_генетика` `2026-04-06` (was `2026-04-10`).
- `колонофлор_16_13.05` absent-with-interval rows: the golden's 10
  detection-limit rows (`Akkermansia muciniphila`, `Candida spp.`,
  `Citrobacter spp.`, `Enterobacter spp.`, `Enterococcus spp.`,
  `Escherichia coli enteropathogenic`, `Klebsiella oxytoca`,
  `Klebsiella pneumoniae`, `Proteus vulgaris/mirabilis`,
  `Staphylococcus aureus`, raw `не обнар`) carried `standard_value: 1.0`
  from an old matcher era; per the documented absent+interval rule
  (fix #6 above) the matcher deterministically emits `0.0`. Goldens
  corrected to `0.0` (confirmed by `validate_offline.py`).
- `рнпц_омр_генетика` `provider`: as of the 2026-08-29 golden update the
  golden carries `Бодиловская А.А.` (mistral-medium's steady pick) with
  `provider_alt` accepting `Субоч Е.И.` and the both-doctors form — all
  variants are printed on the document, so no rerun is needed for provider
  variance anymore.
- `рнпц_омр_генетика`: the golden's four qualitative mutation biomarkers
  (`Мутация в гене JAK2 (12 exon)`, `JAK2 (14 exon; V617F)`, `CALR (9 exon)`,
  `MPL (10 exon)`) carried `standard_unit: "ratio"` — wrong: these are
  qualitative tests ("Не выявлена" / "Not detected") with no physical unit.
   The matcher already emits `""` for them (`_guess_unit` mutation branch in
   `app/services/matcher/units_guess.py`, and `verify_or_create` persists `canonical_unit:
  ""` on first-seen), so the observed output was `""` vs. the golden's
  `"ratio"`. Golden corrected to `standard_unit: ""` 2026-08-03.
- **Fresh-DB ordering dependency (`колонофлор_16_*`)** — OBSOLETE as of fix
  #13 (2026-08-29): canonical units are first-seen, but log-scale first-seen
  rows now anchor the LINEAR magnitude (`_linearized_anchor`), so
  `колонофлор_16_13.05` (raw unit `lg копий/мл`) no longer poisons the
  anchors when it runs first alphabetically. Both goldens regenerate
  identically in any order on a fresh `e2e_run.db`. (Historical: before the
  fix, 13.05-first anchored `lg copies/mL` and BOTH колонофлор cases failed
  against the linear goldens; the warm-up ordering below was the workaround.)
  Still harmless and still the convention:
  `venv/bin/python e2e/run_e2e_server.py --case колонофлор_16_25.06` once
  before the full suite after any DB reset.
- `гастроэнтеролог_ргц_29.06`: the LLM now splits the long
  `Лабораторная и инструментальная диагностика…` recommendation block into
  separate items and truncates the longest texts, so `recommendations` counts
  (golden 4 vs observed 5) and long texts mismatch (similarity 0.02-0.39).
  This repeated identically on two consecutive runs (temp-0 extraction, LLM
  drift since the golden was verified); rerun to check, but the golden may
  need re-verification of the recommendations block.
- `оак_26.05`: `MCH` raw-name OCR variance (`MCH (ср. содер. Hb в эр.)` vs
  `MCH (ср. содерж. Hb в эр.)`) makes the row MISSING/UNEXPECTED on some
  runs; the provider field can also swap to a different signature name
  (e.g. `Гусар Т.В.` vs `Выдрицкий А.В`). Both are transient OCR/LLM noise.
- The `колонофлор_16_13.05` `Bacteroides thetaiotaomicron` row is OCR-flaky
  on its `допустимо любое количество` reference cell: when the LLM recovers
  the cell the matcher emits `{kind: interval, low: null, high: null}` +
  `value: 0.0`; when the cell is dropped the matcher emits `{kind:
  qualitative, expected: null}` + `value: "Not detected"`. The two
  encodings are semantically equivalent and the comparator now accepts both
  (see the comparator-accommodations section) — the case no longer flaps on
  this row.
- LOINC defs are promoted from `data/Loinc.csv` on first demand and persisted.
- `app/mock_db.py` is **not** part of the server data path — the server seeds
  from `Loinc.csv` via `seed_loinc`. Edits there have no effect.
