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

---

## LOW / UI dead-ends

### 6. Header RU→EN language toggle does nothing

- File: `frontend/src/components/health-passport/header-bar.tsx:44,151-159`
- `const [lang, setLang] = useState<'RU' | 'EN'>('EN')` only drives the
  segmented-button highlight. No content anywhere reacts to `lang`.
- The print translation is configured separately on `/print-setup`
  (`print-setup.tsx`), so the header toggle is a dead control.

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