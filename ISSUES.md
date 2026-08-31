# HealthPassport — Issue Log (bugs, inconsistencies, feature backlog)

Convention: when an issue is resolved, delete its entry (the git history
keeps the log traceable) — feature entries (`F<n>` below) follow the same
rule and are numbered independently of the historical bug numbers referenced
from the docs. When a fix makes a documented statement false (observable
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

## Feature batch "Account & Data" (shipped 2026-08-31)

The 2026-08-31 product analysis identified four user-facing gaps: no
export/backup path for the structured data, invisible usage limits (only
reactive 429 toasts), and no account self-service. All five planned features
(F1–F5) were implemented in one batch and their entries deleted per the
convention above — the shipped contracts are documented in
`backend/docs/architecture.md` (export endpoint, change-password,
account deletion, shared `upload_cleanup.unlink_unreferenced_files`) and
`frontend/docs/architecture.md` (Settings page: profile, usage meters,
data-export card, danger zone).

### Candidate future features (not scheduled)

- **Quota model revamp**: lifetime counters → rolling/monthly reset (public
  deployment); surface remaining quota near the upload flow (currently only
  the settings usage card + reactive 429s).
- **One-click PDF download** of the passport document (the print flow
  currently ends in `window.print()`, `print-editor.tsx:615-623`).
- **Backup restore/import** to complement `GET /api/export`.

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