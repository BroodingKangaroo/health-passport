# Product Roadmap — Growth & Trust

**Status:** approved direction; Phase 0 partially shipped (statuses marked
below).
**Created:** 2026-08-31. **Updated:** 2026-09-03 (0.1/0.2/0.3/0.5 shipped;
0.3 redesigned as a landing-embedded demo surface).
**Scope:** user-experience and marketing-driven improvements. Technical designs are
summarized at roadmap level with code pointers for implementers; detailed designs
happen per-feature at implementation time.

---

## 1. Mission & pitch

> **People should own their health.** Good doctors are overloaded — the system
> works better when patients arrive informed. HealthPassport gives people full
> access to, and understanding of, what is happening in their body, so they can
> be an informed partner to their doctor instead of a passive passenger.

The product pitch follows from the mission: your labs, decoded; your history in
one place; your doctor's time respected.

## 2. Marketing principles

These principles drive all copy and design decisions. When a feature or a
sentence conflicts with one of these, the principle wins.

1. **Ownership, not storage.** "Your data is yours" is a feature, not fine
   print. Delete / export / anonymous trial are marketed on the first screen,
   not buried in Settings.
2. **Understanding, not numbers.** The pitch is *decoding*, not archiving.
   Plain-language framing ("what this means for me") over clinical jargon in
   onboarding copy.
3. **Prepared partnership, not doctor-replacement.** Sharing and the print
   passport are framed as "arrive prepared, save your doctor's time."
   Pro-doctor positioning — both true to the mission and safer than
   anti-establishment framing.
4. **Show, don't ask for trust.** Demo mode and transparent AI disclosure
   replace claims of trustworthiness.
5. **Design for the AI-hesitant.** People fluent in AI can self-educate; the
   underserved group is everyone who won't type symptoms into a chatbot.
   Therefore: help must be one tap, never a text box ("zero-prompt
   interactions"); frame features as "plain-language explanations," not "AI
   assistant" — for this audience "AI" can lower trust; show the receipt —
   explanations visibly grounded in the user's own numbers and reference range.
6. **Calm, glanceable design.** Medical data is stressful; visual clarity *is*
   a trust feature, in the same category as privacy copy and demo mode.
   Recognition over interpretation.

## 3. Personas

Priority order:

1. **Regular people** who want a detailed overview of their clinical track
   record.
2. **Chronic-condition patients** for whom flowsheet/trends and accuracy are
   the hook.
3. **Travelers** who need medical info saved and presentable abroad (existing
   differentiators: EN/RU UI, print passport in 7 languages).

Cross-cutting audience characteristic: **AI-hesitant users** who need help with
their health outside doctor visits (see principle 5). Most features below serve
all personas; each phase lists the personas it primarily serves.

---

## Phase 0 — Trust & onboarding

Serves all personas. This is the conversion gate: nothing else matters if
first-time visitors don't hand over their first document.

### 0.1 Landing page + true empty state — ✅ SHIPPED

- Shipped in commit `5182b61`: `/` renders `LandingGate`
  (`frontend/src/components/landing/landing-gate.tsx`), a client-side gate on
  "zero entries" — first-time visitors get the hero (mission-led value pitch,
  "try without account" via anonymous sessions, ownership badges); users with
  data go straight to the timeline.
- All copy via the `landing` EN/RU i18n catalog, covered by the parity test.
- The hero's secondary CTA links to the demo surface (0.3).

### 0.2 Privacy policy + AI disclosure — ✅ SHIPPED

- Shipped in `5182b61` (upload-flow disclosure + landing footer note) and the
  demo-mode change: a localized privacy policy page (`/privacy`,
  `frontend/src/app/privacy/page.tsx`, `privacy` catalog) linked from the
  landing footer and the settings page. It discloses Mistral/OpenRouter
  processing, that documents are not stored by the AI service, export/delete
  rights, and the not-medical-advice boundary.
- Sequencing rule: any public announcement driving traffic to the product is
  gated on this page being live — now satisfied.

### 0.3 Demo mode — ✅ SHIPPED (as a landing-embedded demo surface)

- Original sketch (seeding sample rows into the anonymous session) was
  **redesigned and simplified during implementation**: instead of seeding DB
  state (with its column, endpoints, purge, and migration-skip machinery),
  the demo is a static marketing surface at `/demo` that renders the real
  timeline components from a fully fictional fixture — "this way it
  definitely works": no backend, no API calls, no session/quota interaction,
  nothing to clean up, and the user's data is never touched.
- As built (`frontend/src/demo/demo-data.ts`,
  `frontend/src/components/landing/demo-view.tsx`): fictional patient,
  clinic, doctor, and narrative (no real person's data anywhere — the e2e
  golden cases are the maintainer's real results and are used only as format
  reference); authored values exercising the full status model; bilingual
  names; day-offset dates that never age; entry fields mirroring the
  extraction save path. Stateful affordances with nothing to act on (entry
  deletion, full-details navigation, real-data views) are hidden on the
  surface; a banner explains the fictional data and carries the conversion
  CTA to `/add-entry`.
- Reached from the landing hero ("See live example"); copy in the `demo`
  EN/RU catalog.
- Historical notes (resolved): `copy_anonymous_data` DOES copy
  `InstrumentalData` (the migration gap once listed here and in Phase 5 is
  fixed); `backend/e2e/inputs/` holds 9 documents (the roadmap once said 8).

### 0.4 Working password reset (+ email change)

- The whole reset flow already exists (`PasswordResetToken` model,
  `POST /api/auth/forgot-password` with throttling, token-consuming
  `POST /api/auth/reset-password`) — it is inert only because SMTP is disabled
  by default (`SMTP_ENABLED` in `backend/config.py`; the reset link goes to
  server logs).
- Deploy with real SMTP; make failure states user-visible rather than silent.
- Add email change (missing entirely; email is read-only in
  `settings/profile-card.tsx`).

### 0.5 AGENTS.md doc-drift fix — ✅ SHIPPED

- AGENTS.md claimed `backend/.env` and `backend/.jwt_secret` are "committed
  dev-only secrets"; they are in fact gitignored and untracked. Corrected in
  AGENTS.md alongside the demo-mode change.

### 0.6 Timeline scannability

- Problem: timeline rows are visually generic — blood tests vs doctor visits
  are not distinguishable at a glance.
- Give each event type (blood test / doctor visit / instrumental test) a
  distinct icon + consistent color family, applied consistently across the
  history list, detail-view headers, and the flowsheet, so the visual language
  carries everywhere. Timeline rail nodes take the type color.
- **Rule:** status colors stay semantic (`low`/`high`/`abnormal`) and type
  colors stay categorical — the two channels must never be mixed, or "high"
  stops meaning anything.
- Must respect dark/light theme and EN/RU labels.

---

## Phase 1 — Differentiators (flagship)

Serves all personas; ① and ③ strongest. The two features that make the mission
visible and create pull.

### 1.1 Shareable read-only link (killer feature)

The only feature where **non-users experience the product**: every doctor or
relative who opens a link sees HealthPassport working. It is the digital,
always-current alternative to the print passport (stale email attachments vs.
a live, revocable link).

**V1 scope**

- Share the whole passport, optionally limited to a date range. Full selective
  sharing (per-entry / per-biomarker) is a deferred candidate.
- Sender controls: default expiry (e.g., 7 or 30 days) + manual revoke;
  multiple active links allowed; optional inclusion of the personal header
  (name/DOB) — off by default for privacy.
- No signup for senders: available to anonymous-session users too, consistent
  with the anonymous trial funnel.

**Recipient experience is the product**

- Zero friction: no account, no install, works on a phone.
- Opens to a 30-second doctor-scannable view: abnormal flags first, then
  trends; localized; biomarker names reuse the existing 7-language translation
  flow (`/api/translate-biomarkers/commit` persists translations into
  `names[lang]`).
- Read-only by construction — no editing, no uploads, no personal data of the
  recipient.
- Subtle "Make your own HealthPassport" CTA on the shared view (the viral
  loop).

**Technical shape (verified against current code)**

- No share/public-read concept exists anywhere; every endpoint today is
  tenant-scoped via `get_current_user_or_anon`.
- New `ShareLink` model alongside existing models in `backend/app/db/models.py`
  (token *hash* stored, not the raw token; scope; expiry; revoked flag).
- Public read-only GET endpoints; the attachment file-serving guard in
  `backend/app/main.py` must accept share-token scope as an alternative to
  owner scope.
- Frontend: public route outside the authed app, read-only, reusing
  results-panel-style components; PDF/print from the shared view relies on the
  browser's print → Save-as-PDF for now (one-click PDF generation is a
  deferred candidate).

### 1.2 AI biomarker explanations ("Decoded")

The mission made concrete: understanding, not numbers.

**Interaction (zero-prompt, for the AI-hesitant)**

- One tap on any reading in the biomarker detail view
  (`blood-test-details.tsx` / expanded biomarker details): "What does this
  mean?" — never a text box.
- Explanation panel, three parts:
  1. **What this biomarker is** (plain language, no jargon).
  2. **What *your* low/high may mean in your context** — grounded in the
     persisted per-reading `status` + `reference` snapshot and the profile
     (age/gender). Show the receipt: the user's own numbers are visible in the
     explanation.
  3. **What to do next** — who to consult, when to worry ("see a doctor now
     if…"), always closing with "discuss with your doctor."

**Guardrails (first-class, see Safety section)**

- Explainer, not diagnostician. Persistent "not medical advice" label.
- Red-flag language routes to urgent care; the feature never suggests a
  diagnosis or medication changes.

**Serving & cost**

- UI locale (EN/RU) responses; short.
- Shared explanation content is cached per biomarker + status + locale, with a
  thin personalized layer; rate-limited to control Mistral spend.
- On-demand read path only — no changes to the extraction pipeline, so the
  e2e golden harness is untouched. LLM infrastructure already exists in
  `backend/app/api/ai.py`.

---

## Phase 2 — UX friendliness pass

Serves all personas; compounds everything above. Developer-driven, no rebrand.

- True per-view empty states (the zero-data hero is the Phase 0 landing; this
  covers filtered/empty views — today only a small "no matching events" block
  exists in `history-list.tsx`).
- Mobile comfort pass (the recipient-first shared view sets the bar).
- Consistency audit: cards, spacing, typography across views.
- Color-semantics audit: finish and enforce the Phase 0.6 type/status color
  rule product-wide.
- First-run guidance: a gentle checklist, not a modal tour.

---

## Phase 3 — Value loop

Serves ① and ③. The *ability* to leave increases willingness to arrive.

### 3.1 Backup import/restore

- Export exists (`GET /api/export?format=json|csv`,
  `backend/app/api/account.py`, envelope `healthpassport-export/v1`); nothing
  consumes it today.
- Add `POST /api/import` for the JSON envelope: recreate entries/readings;
  remap local-definition ids (deterministic `local-{user_id}-{md5}` format)
  with a documented conflict policy (skip / create-new).
- Known envelope limitations to document in v1: attachment *files* are not in
  the envelope (only paths) — v1 imports data rows, files re-uploaded
  manually; extending the envelope (e.g., zip with files) is a candidate.
- CSV is a viewing format only, not restorable — say so in the UI.

### 3.2 Granular deletes

- Today only whole-entry delete (`DELETE /api/entry/{id}`) and whole-account
  deletion exist.
- Add reading-level delete: must clean up `merged` / `merged_source` flags
  (`backend/app/db/models.py`), which the timeline reads per-event
  (`biomarkersAtDate`); status is already persisted per reading, so no
  recompute is needed.
- Add definition-level delete for *orphaned* local definitions (entry deletion
  currently leaves them behind; only account deletion removes them).

---

## Phase 4 — Admin curation

Serves the platform: promoted definitions improve the shared dictionary and
matcher quality for everyone (retention flywheel).

**Confirmed design decisions:** promote-or-merge; tracked rejection; audit
log.

### 4.1 Roles & access

- `is_admin` boolean column on `Patient` (existing users table is `Patient`;
  new columns auto-migrate via `migrate_add_columns()` in
  `backend/app/db/session.py`).
- Bootstrap: `backend/scripts/make_admin.py` (mimics existing script patterns)
  — no self-serve admin creation.
- Enforcement: DB-checked `get_current_admin` dependency (403 otherwise) — a
  DB check, not a JWT role claim, because tokens live 7 days and admin rights
  must be revocable instantly.

### 4.2 Review queue API

- `GET /api/admin/local-definitions`: list `scope=="local"` definitions with
  **usage counts** (readings referencing them — a strong "reasonable"
  signal) and pre-computed fuzzy **"similar global exists"** flags (reuse
  `backend/app/services/matcher/name_matching.py`: `build_name_index`,
  `fuzzy_match`).
- Actions:
  - **Promote** — creates a global definition in a new id namespace (e.g.,
    `hp-…`; globals today are keyed by LOINC code, with runtime global
    creation precedent `_promote_loinc_from_csv`). Optional LOINC code input
    (then id = LOINC). Carries the local def's `canonical_unit`,
    `canonical_kind`, and `reference` — carrying the canonical unit is what
    makes repointing safe. Repoints all referencing readings to the new
    global (remap pattern exists in `data_migration.py`) and deletes the
    local row.
  - **Merge into existing global** — offered when a fuzzy duplicate is
    flagged: repoints readings to the existing global, merges the local
    name/synonyms into it (synonym-merging precedent in
    `verify_or_create`, `definitions.py`), deletes the local row.
  - **Reject** — persisted `review_status` column on definitions
    (`pending`/`promoted`/`rejected`) + `reviewed_at`; recoverable and
    survives the def being re-created by the next extraction.
- Audit: `AdminAuditLog` table (admin id, action, target id, timestamp) for
  every promote/merge/reject.

### 4.3 Privacy boundary (explicit)

- Admins see definition *metadata* only — names/synonyms/unit/reference, which
  are document-derived; never readings, values, entries, or identity. `user_id`
  is an opaque id and stays unexposed in admin responses.

### 4.4 Frontend

- Separate `/admin` route (settings is a user-facing card grid); requires
  `is_admin` exposure in `/api/auth/me` (`UserResponse`) and a conditional
  nav link; EN/RU catalogs throughout.
- Queue UI: filters (pending/promoted/rejected, has-duplicates), per-def
  cards with names, unit, category, reference, usage count, duplicate
  suggestion, and the three actions.

### 4.5 Doc-sync obligations

- This feature changes a documented invariant: global definitions are no
  longer exclusively LOINC-seeded. Update `backend/docs/architecture.md`
  (scope model, promotion semantics, admin endpoints),
  `frontend/docs/architecture.md` (admin route), and the AGENTS.md statement
  about the LOINC dictionary as single source of truth.

---

## Phase 5 — Retention

Serves ② primarily.

- **Flowsheet/trend depth** for longitudinal tracking (longer ranges, per-
  biomarker views).
- **Matcher accuracy**: burn down residual `backend/e2e/KNOWN_ISSUES.md`
  classes (OCR spelling variants, translation phrasing drift, noisy
  title/recommendations fields) using the live benchmark loop
  (`backend/benchmark/run_benchmark.py`).
- **JWT revocation** after password change/reset (today old tokens stay valid
  for up to 7 days — documented gap in `backend/app/api/auth.py`).
- **Monthly quota reset** (ISSUES.md candidate; current quotas are lifetime
  counters).

---

## Safety & compliance guardrails (cross-cutting)

- **No diagnosis claims.** The explanation feature is an explainer, not a
  diagnostician: no diagnoses, no medication advice; red-flag language routes
  to urgent care; every explanation closes with "discuss with your doctor."
- **Transparency.** Privacy policy live before public launch; AI-processing
  disclosure at upload; shared links expire, are revocable, and are
  scope-limited; admin actions audited; admin sees metadata only.
- **Positioning.** Pro-doctor, pro-partnership. Never anti-establishment, never
  "replace your doctor."
- **Data ownership.** Export and full deletion always work and are always
  discoverable; shared views are read-only by construction.

## Verification & doc-sync

- Backend: `python -m pytest tests/ -v`, `venv/bin/ruff check .` (from
  `backend/`).
- Frontend: `pnpm lint`, `pnpm test` (vitest). All new user-facing strings go
  into the EN/RU catalogs with parity test; EN strings are pinned by existing
  tests — do not reword them. Component tests need `TestI18nProvider`.
- E2E golden harness: untouched for Phases 0–3 (no extraction-pipeline
  changes); run manually via `backend/e2e/run_e2e_server.py` when needed.
- Doc sync per AGENTS.md: update `backend/docs/architecture.md` /
  `frontend/docs/architecture.md` / AGENTS.md in the same change whenever a
  shipped item changes an observable contract (API shape, persisted model,
  reference/status semantics, matcher rules, proxy rewrites, harness
  behavior). Cosmetic or mechanical changes: skip.

## Deferred candidates

- Full selective sharing (per-entry / per-biomarker links).
- Export envelope v2 with attachment files (zip) + full restore including
  files.
- One-click PDF as an email attachment for share recipients.
- One-click PDF download of the passport (client-side generation over the
  existing print DOM; until then `window.print()` → Save-as-PDF remains the
  path).
- Full visual rebrand (typography/colors/logo) — revisit after first-user
  feedback.
