# HealthPassport — Bug / Inconsistency Log

Audit date: 2026-08-02. Findings verified against the current working tree
(repo has uncommitted refactoring: frontend Playwright e2e removed, backend
serializers hoisted into `app/api/_serializers.py`, several scripts deleted).
Line numbers refer to files as they stand now.

---

## HIGH

### 3. "Forgot password?" is a dead link; password reset not implemented

- File: `frontend/src/app/login/page.tsx:87` links to `/forgot-password`
- No such route exists (only `/login` and `/register` under `src/app`).
- Backend has no reset endpoint (`grep -ri "forgot\|reset.password" backend` → nothing).
- Clicking the link → 404 on a route that was never built.

---

## MEDIUM

### 4. Header "Add New Entry" menu options are all identical

- File: `frontend/src/components/health-passport/header-bar.tsx:25-30, 126-137`
- All three options — "Add Lab Result", "Log Doctor Visit", "Upload MRI Scan" —
  call `router.push('/add-entry')` with no type/param. The AddEntry page then
  opens on the **Lab Results** tab by default (`add-entry.tsx:121`, `documentType`
  default `blood_test`; the in-page pills are at `add-entry.tsx:60`).
- So "Upload MRI Scan" from the header lands the user on the blood-test upload
  flow; the doctor-visit / MRI forms are only reachable by clicking the in-page
  pill after arrival. The menu is misleading — its options don't do what they
  say.

### 5. AGENTS.md documents Playwright E2E that was deleted in the refactor

- Affected: `AGENTS.md:23,41` vs actual repo state.
- `AGENTS.md` claims:
  - `pnpm test:e2e` → Playwright, with `playwright.config.ts` auto-starting
    both servers (`AGENTS.md:23`)
  - CI has three jobs including a Playwright e2e job (`AGENTS.md:41`)
- Actual state (working tree):
  - `frontend/e2e/` deleted (specs, global-setup/teardown) — see `git status`
  - `frontend/playwright.config.ts` deleted
  - `package.json` has no `test:e2e` script; no `@playwright/test` dep
  - `.github/workflows/tests.yml` only has `backend-test` + `frontend-test`
    (2 jobs, no Playwright job)
- Docs either need updating to describe the backend-only golden harness, or the
  frontend e2e must be restored.

---

## LOW / UI dead-ends

### 6. Header RU→EN language toggle does nothing

- File: `frontend/src/components/health-passport/header-bar.tsx:44,151-159`
- `const [lang, setLang] = useState<'RU' | 'EN'>('EN')` only drives the
  segmented-button highlight. No content anywhere reacts to `lang`.
- The print translation is configured separately on `/print-setup`
  (`print-setup.tsx`), so the header toggle is a dead control.

### 7. Extract SSE endpoint hardcodes port 8000 in the browser (deploy concern)
- File: `frontend/src/services/api.ts:33-39`
- `streamApiBase()` falls back to
  `window.location.protocol://window.location.hostname:8000/api` when
  `NEXT_PUBLIC_API_URL` is unset.
- `docker-compose.yml` publishes the backend on the host's port 8000, so this
  works on a single machine, but any deployment where port 8000 is not exposed
  externally will fail `POST /api/extract` for the streaming path, while every
  other API call correctly goes through the `STATIC_PROXY_URL` rewrite. Needs
  `NEXT_PUBLIC_API_URL` to be set in such environments.

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