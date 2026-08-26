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

### 29. Source-language modeling: `names['ru']` doubles as the "source name" slot (deferred)

- The data model has **no persisted source language**. `BiomarkerDefinition.names['ru']`
  doubles as the slot for the name exactly as printed in the source document
  (whatever its language), `reading.original_name` carries the same per
  reading, and several consumers rely on that conflation:
  - `app/api/entries.py` resolves manually-typed rows by matching against
    `names['ru']`.
  - `app/api/flowsheet.py` falls back to `names.get("ru")` when building the
    matrix `original` column.
  - `print-editor.tsx` renders `row.original` for the `ru` output language.
- Consequence: a non-Russian document stores e.g. German text under the
  `ru` key. Everything works today because the same string is meant
  throughout, but the semantics are wrong and block honest features like
  "translate from source → X for any X" or per-document language stats.
- A real fix needs a dedicated field (e.g. `names[src]` or a
  `source_language` column + migration), matcher/serializer/entry-resolution
  updates, and backfill for existing rows. Deferred — no code changes
  planned; the user-facing label was neutralized instead ("Keep Original",
  no "(Russian)").

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