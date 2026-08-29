# HealthPassport — Bug / Inconsistency Log

Convention: when an issue is resolved, delete its entry (the git history
keeps the log traceable). When a fix makes a documented statement false (observable
contract: API shape, data model, reference/status semantics, matcher/unit
rules, proxy rewrites, merge/unit-conflict behavior, harness/safety), the
affected docs (`backend/docs/architecture.md`, `frontend/docs/architecture.md`,
`backend/e2e/README.md`, AGENTS.md invariants) must be updated in the same
change; cosmetic/mechanical and behavior-preserving fixes leave docs
untouched.

Audit date: 2026-08-02. Findings verified against the current working tree
(the e2e refactor referenced below is committed as `feca353`: frontend
Playwright e2e removed, backend serializers hoisted into
`app/api/_serializers.py`, several scripts deleted). Line numbers refer to
files as they stand now.

---

## Proposed features (not yet built)

### 36. Persisted source-document language (`medical_entries.source_language`)

- The data model persists **no source language** anywhere: `RawMedicalRecord`
  (`app/schemas/ai.py`), `medical_entries`, `biomarker_definitions.names`,
  and `biomarker_readings` all carry none (verified 2026-08-29). The de-facto
  source-name slots are language-agnostic: `reading.original_name`
  (per-reading, exactly as printed) and `defn.synonyms` (raw name appended at
  definition creation); definition `names` holds only real translations keyed
  by real codes (`en` + persisted `de|fr|es|he|pl` from
  `/api/translate-biomarkers`).
- Blocked user-visible features: an "Original (German)"-style label on the
  print/export "Keep Original" mode (it renders `row.original` unlabeled) and
  per-document language stats. `PrintLang`'s `'ru'` member is the internal
  "original mode" sentinel (persisted as `targetLanguage: 'ru'`), unrelated
  to real Russian.
- Proposed approach: a nullable `source_language` column on `medical_entries`
  (NULL = unknown; no backfill for existing rows), auto-migrated by
  `migrate_add_columns()` (`app/db/session.py`). Detect deterministically at
  extraction time via script heuristics (Cyrillic → `ru`, Hebrew script →
  `he`; Latin-script languages need common-word heuristics) — do **not** add
  an LLM field to the extraction prompt: prompt changes risk e2e golden drift
  and benchmark spend for a field the goldens never compare. Surface through
  the entry serializers so the frontend can label the original column.
- Rejected: a def-level `names[src]` slot — cross-document local unification
  (`eda09b5`) deliberately merges multiple labs' wordings under one
  first-seen def, so a def-level "source name" is ambiguous;
  `reading.original_name` is already the honest per-reading slot.

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