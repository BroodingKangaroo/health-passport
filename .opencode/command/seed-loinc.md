---
description: Seed the LOINC biomarker dictionary (drops and recreates the DB).
---

Seed LOINC biomarker definitions for HealthPass.

**DANGER: this drops and recreates the database.** It deletes all entries,
readings, users, and uploaded data. Only run it when the user explicitly wants
a fresh local DB.

1. Confirm with the user before running — this is destructive.
2. Run `backend/venv/bin/python -m app.db.seed_loinc` with the working
   directory set to `backend/`.
3. It seeds `biomarker_definitions` from `data/Loinc.csv` (lab-relevant
   classes, common-ranked) and applies curated reference ranges.
4. The LOINC dictionary is the **single source of truth** for biomarker
   definitions — keep it stable while a golden is in use or mappings drift.
   Remind the user of this after running.

If $ARGUMENTS is non-empty, it is passed to the seeder as extra args.