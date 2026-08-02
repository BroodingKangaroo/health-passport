# HealthPassport — Bug / Inconsistency Log

Audit date: 2026-08-02. Findings verified against the current working tree
(the e2e refactor referenced below is committed as `feca353`: frontend
Playwright e2e removed, backend serializers hoisted into
`app/api/_serializers.py`, several scripts deleted). Line numbers refer to
files as they stand now.

---

## HIGH

### 3. "Forgot password?" is a dead link; password reset not implemented

- File: `frontend/src/app/login/page.tsx:87` links to `/forgot-password`
- No such route exists (only `/login` and `/register` under `src/app`).
- Backend has no reset endpoint (`grep -ri "forgot\|reset.password" backend` → nothing).
- Clicking the link → 404 on a route that was never built.

### 8. Imaging / MRI entries are saved without any imaging data and have no detail/delete view

- `frontend/src/components/health-passport/add-entry.tsx:911-915` offers
  "MRI / Imaging Scan" and collects `imagingFormData`, but
  `buildSaveEntryFormData` (`api.ts:227-244`, used at `add-entry.tsx:510-521`)
  never appends imaging data and backend `save_entry`
  (`backend/app/api/entries.py:461-496`) has no imaging form field — no
  `ImagingData` model exists at all.
- Saved imaging entries render "No detailed view available for this event type."
  (`frontend/src/views/TimelineView.tsx:94-97`) with no Settings/Delete tab.
- Switching Document Type after an AI extraction leaves the extracted biomarker
  rows in `categories`, which are still persisted (`add-entry.tsx:518`), so an
  "Imaging" entry can silently carry invisible blood-test readings.

### 9. Failed AI extraction still burns quota; no retry path

- File: `backend/app/api/ai.py:112` — the extraction-count increment is written
  with `db.commit()` right after file-format validation but *before* OCR
  (lines 141-150) and LLM extraction. A document whose OCR/extraction fails
  consumes 1 of the 5 anonymous (or 50 registered) extractions for nothing;
  only file-validation failures (400) are refunded.
- Frontend: `frontend/src/components/health-passport/add-entry.tsx:310-325`
  shows "Switched to manual entry" with **no "Try again"** control, and the
  failed file stays selected as if it will be attached on Save.

### 10. Print "AI translation" is cosmetic — de/fr/es/he output is English

- Files: `frontend/src/components/health-passport/print-setup.tsx:59-61,43-46`
- "AI translation of medical terminology may take a few moments." is printed,
  but "Generate Document" only does `router.push('/print-editor')` — no
  translation API call, no backend translation endpoint.
- Production definitions carry only `en` names
  (`backend/app/db/seed_loinc.py:236` seeds `{"en": …}`; `matcher.py` local
  defs are `en`-only), yet `translatedName()` (`print-editor.tsx:229-235`)
  looks up `def.names[lang]`. The unit tests pass only because fixtures
  (`backend/tests/seed_data.py`) carry full multilingual names maps. Result:
  selecting German/French/Spanish/Hebrew renders English biomarker names, and
  `he` has no translation data anywhere.

---

## MEDIUM

### 13. Anonymous → registered "transfer my data" drops fields

- Files: `backend/app/services/data_migration.py:89-96,153-164`
- Copied `BiomarkerDefinition`s lose `canonical_unit`, `canonical_kind`,
  `canonical_unit_inferred`; copied readings lose `scale_function`,
  `needs_review`, `merged`, `merged_source`. After "Transfer my data",
  merged-entry sections and cross-scale conversion warnings vanish for migrated
  data, and future cross-document unit conversions never engage on those defs.

### 14. Older entries show the newest reading's metadata

- File: `backend/app/api/_serializers.py:108-114` — `result_schema` reads
  `original_name/original_value/original_unit/original_range` from the **latest**
  reading.
- `frontend/src/views/TimelineView.tsx:117-134` (`biomarkersAtDate`) overrides
  only `value/date/status/merged`, so the "Original Name" column
  (`results-panel.tsx:186`) shows the newest doc's name while displaying the
  older value. The chart reference band is drawn from
  `definition.reference` (`BiomarkerChartInner.tsx:86`) whereas the shown text
  and status use the per-reading reference (`results-panel.tsx:195`) — the green
  band and a cell's "high/low" verdict can contradict when ranges changed.

### 15. "Insights & Correlation" delivers no correlation and drops common cases

- File: `frontend/src/components/health-passport/correlation-chart.tsx`
- Single-measurement biomarkers — the common one-test onboarding case — are
  excluded because `history` is `[]` for them (`timeline.py:90-93`), so the
  picker is empty ("Select at least one biomarker…" shows while checkboxes stay
  ticked; `correlation-chart.tsx:99-101,118-121`).
- One-sided references (`≤ 0.7`) produce null bounds → the series is silently
  dropped with no message (`:146-158`).
- Fixed Y domain `[-20, 120]` clips values above 3× the upper bound (`:280`).
- No correlation coefficient, p-value, or regression exists anywhere; the dashed
  "bridge" (`:168-189`) invents a constant flat trend across gaps, and tooltips
  render blank rows for dates without readings.

### 16. Same-date blood tests are ambiguous in selection, flowsheet, and headers

- `biomarkersAtDate` matches by exact `date` string only
  (`TimelineView.tsx:113`); two unmerged tests on one date → `findIndex` always
  returns the first, so selecting the second test shows the first test's values
  and merged-flags.
- Backend sorts blood tests by `date` only (`flowsheet.py:36-44`, and the
  timeline's readings/events order likewise), so same-day ordering is
  nondeterministic and the "(Latest)"
  badge (`flowsheet-matrix.tsx:110-112`) can sit on the earlier test. When three
  tests share a day with mixed sub-labels where two collide `(#)` dedupe
  (`flowsheet.py:71-78`) skips → two identically-labeled columns.

---

## LOW / UI dead-ends

### 6. Header RU→EN language toggle does nothing

- File: `frontend/src/components/health-passport/header-bar.tsx:38,151-159`
- `const [lang, setLang] = useState<'RU' | 'EN'>('EN')` only drives the
  segmented-button highlight. No content anywhere reacts to `lang`.
- The print translation is configured separately on `/print-setup`
  (`print-setup.tsx`), so the header toggle is a dead control.

### 20. Blank/future dates and empty rows accepted silently

- Files: `frontend/src/components/health-passport/add-entry.tsx:813-819` and
  `backend/app/api/entries.py:47-49,168-171`
- The date input is not required and has no max/future guard; a blank date saves
  as "today", and a future date saves too (breaking timeline ordering).
- Rows with an empty name or value are silently dropped on save with no warning.
- Duplicate-test detection fetch errors are swallowed (`add-entry.tsx:353-355`),
  so the "Time (required)" / merge warning can silently disappear while save
  stays enabled → duplicate entries.

---

## Verified working (explicitly checked, no findings)

- Auth round-trip (JWT ⇄ NextAuth), anonymous-session id, `fetchAuthedObjectUrl` /
  `printAuthedDocument` for protected uploads, per-user file authorization in
  `app/main.py:57`
- Delete entry + usage counter refund; same-date merge feature & merged-readings
  sections in timeline only
- Unit-conversion dialog + flowsheet `ScaleNote` (cross-scale log↔linear); the
  merged/biomarkers-at-date flag handling (`TimelineView.biomarkersAtDate`)
- LOINC reference model (interval/qualitative), compact number formatting,
  reference editor, registration + DOB validation