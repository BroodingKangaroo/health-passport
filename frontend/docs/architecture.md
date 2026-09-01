# Frontend architecture (HealthPassport)

On-demand companion to AGENTS.md — read this file before touching API
proxying, reference formatting, merge/unit-conflict UI, the settings tab,
the add-entry editor, or the Insights & Correlation view.

## Stack & commands

- Node 22, package manager **pnpm@11.9.0** (enable corepack). Install:
  `pnpm install --frozen-lockfile`. `pnpm-workspace.yaml` only whitelists
  `sharp` builds.
- Next.js 16, `output: 'standalone'`, **images `unoptimized`**, `recharts`
  transpiled.
- Dev: `pnpm dev` (port 3000). Lint: `pnpm lint`. Typecheck: `pnpm typecheck`
  (`tsc --noEmit`). Unit tests: `pnpm test` → `vitest run`, jsdom env, `@/`
  → `src/` alias.
- **No frontend Playwright suite** (removed in the e2e refactor — no
  `test:e2e` script, no `@playwright/test` dep). End-to-end coverage lives in
  the backend golden harness (see `backend/e2e/README.md`).

## API proxying

API calls are proxied server-side via `next.config.mjs` rewrites: `/api/*`
(except next-auth paths) and `/static/*` → `STATIC_PROXY_URL` (default
`http://localhost:8000`, Docker uses `http://backend:8000`). Don't add
client-side API base URLs that bypass this.

This includes the `/api/extract` SSE stream — the rewrite proxies SSE through
incrementally (verified on Next 16 dev + standalone), so `streamApiBase()` in
`services/api.ts` only differs from `API_BASE` when `NEXT_PUBLIC_API_URL` is
explicitly set (direct-origin escape hatch; requires `CORS_ORIGINS` on the
backend to include the site).

## Print/export translation flow

- `print-setup.tsx` "Generate Document" actually performs its promised AI
  translation: in `translate`/`bilingual` mode with a non-`en` target it
  fetches the flowsheet matrix and calls `POST /api/translate-biomarkers`
  (one batched LLM call per language). While it runs, the button shows a
  spinner with live elapsed seconds ("Translating terminology… Ns") so the
  AI call never feels stuck; the client-side patience cap lives in
  `TRANSLATE_TIMEOUT_MS` in `services/api.ts` (see below; a retry is cheap —
  already-translated names short-circuit server-side).
- The response's per-item `source` (`translated`/`cached`/`fallback`, see
  `backend/docs/architecture.md`) drives the UX: any fresh translations open
  a review dialog (`translation-preview-dialog.tsx`) listing each English →
  translated pair under a "Name used in document" header, with a per-term
  `Translation | English` toggle — active on fresh translations, rendered
  locked on cached/kept-as-is rows (locked to Translation); fallback rows
  have no toggle — the amber "English fallback" label sits in the choice
  column instead; the row always shows the name that will actually print. The dialog is naming-only — it never removes a biomarker from the
   document (exclusion lives in the print editor filter), and a footer hint says
   so. Confirming commits ONLY the terms left on `Translation`
   (`commitTranslatedNames` → `POST /translate-biomarkers/commit`, no LLM/quota)
   and navigates to `/print-editor`; "Back" discards the whole run without
   saving anything (a re-generate then re-translates at LLM cost) — Escape
   and a click on the dimmed backdrop discard identically to Back, while
   clicks inside the dialog panel are ignored. A success
  toast states how many terms were saved for future documents. Badges
  distinguish `cached` ("already translated"), `fallback` ("English fallback"
  — a failure), and names the model deliberately returned unchanged — Latin
  terms, acronyms, proper nouns (`translated` but identical to the input,
  badged "kept as-is"); a two-row legend explains both. An all-`cached`
  response skips the dialog entirely — re-generates of an already-translated
  document are instant and free.
- The backend persists translations into the definition's `names[lang]`
  column (see `backend/docs/architecture.md`), so `print-editor.tsx`'s
  `translatedName()` — which reads `def.names[lang]` via the flowsheet's
  per-definition `names` — renders them with no renderer changes.
- **Category/panel headings** are translated in the same batch (sent as
  `opts.categories`, deduped distinct non-empty matrix headings) but never
  written to the definitions: the backend serves repeat headings from a
  shared server-side cache (only genuinely new strings reach the LLM; a
  fully-cached document generates free). The returned map lands in
  `PrintConfigProvider`
  (`categoryTranslations`) and sessionStorage (`hp-cat-translations:<lang>`)
  so refreshing `/print-editor` keeps translated headings; changing language
  re-hydrates from that language's key. The map is keyed by each **raw**
  matrix heading (the editor looks categories up verbatim; the API is keyed
  by their trimmed form). The review dialog shows them
  read-only under "Panel headings (applied automatically)" — they are
  structural groupings, always applied. `print-editor.tsx`'s
  `categoryLabel()` resolves the display label only — grouping/order keys
  stay the raw string; untranslated headings fall back to it. A failed run
  keeps whatever was previously stored for that language.
- Translation failures never block export. On a failed run
  `PrintConfigProvider.suppressSavedTranslations` is set for this navigation
  so `print-editor.tsx` renders the English / source names and raw category
  headings even though saved translations exist on the definitions — honoring
  the "fallback to English" contract. A successful run (or a language switch)
  clears the flag. The failure toast is sticky (`duration: Infinity`) with a
  close button, and
  tells the user the document is in their source language and how to retry,
  so it survives switching tabs. The `original` mode (labeled neutrally
  "Keep Original" — source documents are not necessarily Russian) and the
  `en` target skip the translation call entirely. Client-side patience is
  bounded by `TRANSLATE_TIMEOUT_MS` (150s) in `services/api.ts` — generous
  because the LLM can take well over a minute under load, but capped so the
  UI can't hang forever.
- **Every programmatic exit goes through `exitToEditor()`**, which tears the
  leave-guard down with `disarm({ pop: false })` — deliberately WITHOUT
  popping the history marker — before `router.push('/print-editor')`. Any
  marker pop is forbidden on this path: `history.go(-1)` delivers its
  `popstate` asynchronously, i.e. INTO the in-flight Next.js soft
  navigation, which treats the popstate as a newer navigation intent and
  aborts the pending push — the user stays on `/print-setup` ("the editor
  never opens", seen after a failed run or an all-cached regeneration).
  Order doesn't help; popping must simply not happen. The leftover marker is
  harmless (see leave-guard section): it is absorbed silently by the always-
  on `popstate` handler. The review dialog's confirm path navigates long
  after teardown (plain `disarm()` ran when results arrived), so only the
  three programmatic paths (all-cached shortcut, empty-names branch, failure
  fallback) go through `exitToEditor()`; the `finally` block is just a
  safety net for the aborted-leave path.

## Navigation leave-guard during AI processes

- `LeaveGuardProvider` (mounted in `app/layout.tsx`) prevents accidentally
  abandoning a running AI process. Two call sites arm it: add-entry while
  `uploadState === 'scanning'` (extraction), and print-setup during the
  in-flight translation network call only — once results are back, leaving
  during the review dialog loses nothing (nothing is persisted until
  confirm), so the guard is disarmed there.
- While armed, the browser Back button pops an invisible same-URL history
  marker (`popstate` interception) instead of leaving, reload/close goes
  through `beforeunload`, and every in-app navigation (NavBar tabs,
  HeaderBar buttons, view Back buttons) routes through `confirmLeave()`,
  which shows a styled "Leave while AI is working?" alertdialog.
- Confirming leave fires the process's `arm(message, onLeave)` callback,
  which aborts the in-flight request (AbortController) BEFORE navigating so
  a stale completion can never hijack navigation (e.g. into
  `/print-editor`); the   aborted path stays silent — no toast, no push.
  Choosing "Stay" — or clicking the dimmed backdrop outside the dialog
  panel; clicks inside the panel are ignored — keeps the marker pushed for
  the next Back press.
  `disarm()` is idempotent and by default pops the marker; both
  confirmed-leave and natural completion converge through it. Callers that
  navigate programmatically right after teardown must instead use
  `disarm({ pop: false })` — the marker's `history.go(-1)` delivers its
  popstate into the in-flight soft navigation and aborts it
  (print-setup's `exitToEditor()` is that contract) — and the guard cleans
  up after them: `arm()` never stacks a second marker when the top entry is
  already one, and the (now always-on) `popstate` handler consumes stale
  markers silently, one invisible hop per Back press, whenever the guard is
  disarmed.

## Reference formatting / stats

Mirror of the backend's reference model (see `backend/docs/architecture.md`):

- `frontend/src/lib/reference.ts` — `formatReference`, `intervalBounds`,
  `isOutsideReference`.
- Manual entry sends a structured `reference` object per row (not a range
  string); `frontend/src/components/health-passport/reference-input.tsx` is
  its interval editor.

## Display-time RU translation (qualitative values + units)

Stored data is ALWAYS canonical English — reading values, `reference.expected`
and `canonical_unit`/`unit`. Status computation (save-time, backend),
`isOutsideReference`, `qualitativeToNumber`, matching and sorting all compare
stored strings, so translation happens only at render sites:

- `src/lib/qualitative-labels.ts` — the backend's closed qualitative enum
  (`normalize_qual`: Negative, Positive, Detected, Not detected, Absent,
  Present, Normal, Abnormal) mapped to neutral Russian forms plus the
  "Qualitative"/«Качественный» unit-column word. `qualitativeLabel(value,
  lang)` matches canonically and EXACTLY (case-sensitive); raw document text,
  already-Russian strings and formatted numbers pass through untouched. These
  are domain/document terms — deliberately NOT in the next-intl catalogs
  (same policy as the print editor's own language maps).
- `src/lib/unit-labels.ts` — curated static EN→RU dictionary for the dominant
  canonical units (`mg/dL`→`мг/дл`, `copies/mL`→`копий/мл`, `10*3/uL`→
  `×10³/мкл`, …). Matching normalizes case/`µ`/whitespace; the UCUM long tail
  (`[arb'U]/mL`, `{score}`-style oddballs beyond the curated set) passes
  through verbatim. Units are precision-critical — NEVER route them through
  an LLM translation.
- `formatReference(ref, unit, { full?, lang? })` translates a qualitative
  expected text via `qualitativeLabel` and, for `lang: 'ru'`, the interval
  unit suffix via `unitLabelRu`. `unitLabel(unit, ref, lang = 'en')` localizes
  both the Qualitative word and the unit. Callers pass `useLocale()` (UI) or
  the print editor's document `lang` — only the `ru` maps hit; every other
  language is a passthrough, so all EN-default tests are unchanged.
- Wired render sites: `results-panel` (value/unit/reference cells — but its
  `unitKeyOf` sort key must stay canonical, i.e. call `unitLabel` WITHOUT
  `lang`), `flowsheet-matrix` (cells + reference tooltip), `biomarker-details`
  (+ share text), `expanded-biomarker-details`, `biomarker-combobox` range
  hint, `LabResultForm` qualitative dropdowns (`<option value>` stays the
  canonical enum; only the visible label translates),
  `unit-combobox` (display-only localization in the unit picker: the
  'Qualitative' sentinel renders «Качественный» and, in RU, known units
  render Russian — the sentinel string and the row's stored/typed value are
  still compared/used verbatim; search and "add new" operate on the
  canonical text. `unit-conflict-dialog` keeps `rawUnit`/`standardUnit`
  verbatim on purpose — they show exactly what is stored and compared),
  `print-editor` (cells + reference line, document-language driven).

## Insights & Correlation view

- `views/CorrelationView.tsx` → `components/health-passport/correlation-chart.tsx`.
  The view is a full-height flex column (`h-screen`); the chart grid is
  `h-[calc(100vh-220px)]`, so the two cards stay equal height with room to
  breathe.
- The left card has two tabs: **Top correlated pairs** (default) and
  **Select biomarkers**. The pairs list is ranked by `|r|` (strongest first,
  ties by sample size), scrolls to fill the card, and is auto-selected on
  load; clicking a row applies that pair, highlighted in the list.
- Correlation math lives in `frontend/src/lib/stats.ts` (pure, unit-tested):
  Pearson `r`, two-sided p (t-test, n−2 df, via Lanczos lnΓ + incomplete
  beta), `pairwiseCorrelations` over index-aligned normalized series (null
  slots for missing dates; pairs with < 2 co-present points or zero variance
  are omitted).
- Values are normalized to a 0–100 scale in `correlation-chart.tsx`
  (`normalizedValue`, exported for tests): interval → `(v−low)/(high−low)·100`,
  one-sided → percent of the bound, exact (low=high) → percent of the expected
  value, qualitative 0/1 → 0/100. A zero bound at 0 (e.g. `{low: null,
  high: 0}` "nothing expected" references) can't scale proportionally, so it
  maps binary: at the bound → 0, any excess → 100 — this keeps all-zero
  readings (blasts, plasma cells, …) chartable instead of producing NaN.
- Suggested-pair threshold: **n ≥ 4 shared readings and |r| ≥ 0.5** — the
  n≥4 floor keeps tiny samples (where a perfect fit is trivial) from flooding
  the list with spurious r = ±1.
- Confidence is shown in plain language, never p-values: p < 0.05 →
  "likely a real relationship", else "could still be chance", n < 3 → "too
  few readings to tell".

## AI-guessed unit UI
- A unit cell whose canonical unit was LLM-invented (`canonical_unit_inferred`)
  is flagged only in the **add-entry editor** (`LabResultForm.tsx`): blue
  ring/glow (`ring-2 ring-blue-400/80 bg-blue-50/60 shadow…`) plus an instant
  CSS hover tooltip ("Unit guessed by AI — verify").
- The old amber `InferredUnitNote` triangle was **removed** from the timeline
  (`results-panel.tsx`) and flowsheet (`flowsheet-matrix.tsx`) — do not re-add
  it there.

## Unit-conversion decision dialog

- After `/api/extract`, `AddEntry` scans returned biomarkers for
  `scale_function` (a cross-scale conversion was applied because the doc unit
  differed from the existing canonical). If any exist, `UnitConflictDialog`
  (`unit-conflict-dialog.tsx`) lists them with per-biomarker choice "Use
  converted value" (default) vs "Keep document unit" (warns the biomarker
  graph becomes unusable).
- "Keep document unit" rewrites the form row back to `raw_value`/`raw_unit`;
  it does NOT change the stored definition's canonical unit.

## Extraction failure retry

- When `/api/extract` fails (OCR/LLM error), `AddEntry` falls back to manual
  entry but keeps the selected file, showing a **"Try again"** button in the
  error banner (`runExtraction(selectedFile)` re-runs the whole SSE flow) and
  a **remove (✕)** control on the document preview so a failed file can't be
  silently attached on Save. `removeFile()` clears both `selectedFile` and the
  hidden `fileRef` input, else Save re-attaches via the `fileRef` fallback.
- Removing the document never dead-ends: an empty preview slot shows the
  click-to-attach prompt in every mode (`DocumentPreviewPane`). Picking a
  file there attaches it via the hidden `fileRef` input. In AI mode it then
  re-runs the full SSE extraction (a fresh start, exactly like the dropzone)
  — behind an `ExtractionConfirmDialog` whenever the form currently holds
  data a fresh extraction would wipe (`hasFormData`: filled biomarker rows,
  or extracted visit/instrumental content); an empty form extracts
  immediately. Cancelling keeps the new file attached and the current form
  data intact. Manual mode keeps plain attach-only semantics.

## Merge UI + merged-readings sections

- `AddEntry` (`add-entry.tsx`) shows a merge checkbox when another blood test
  exists on the same date (target dropdown when several exist). Conflicts are
  detected client-side by definition_id/LOINC **and by name** (mirroring the
  server's name-based resolution of manually-typed rows); the checkbox
  auto-unchecks when a conflict appears so saving can never silently create a
  duplicate entry.
- Merged readings show up **only in the timeline details view**
  (`results-panel.tsx`), grouped under a `MergedSectionHeader` describing the
  second upload (title · time, clinic · provider, "Added from a later upload
  on the same date"); the flowsheet and print editor don't show them.
- `biomarkersAtDate` (`views/TimelineView.tsx`) matches readings by
  **`entry_id`** — every `Reading` and `BiomarkerResult` carries the medical
  entry it belongs to, so two unmerged tests on the same date select their own
  values/flags instead of the first date-match. It then copies
  `merged`/`merged_source` from the reading AT the selected event
  (`isLatest`-gated, per-reading flags) — never a `??`-fallback to the latest
  reading's flags. The same `isLatest`-gated copy applies to
  `original_name/value/unit/range`, `reference`, and (ISSUES.md #68)
  `scale_function`/`needs_review` — the top-level `BiomarkerResult` carries
  the latest reading's scale/review flags so the selected event's chip
  renders its `ScaleNote` like every history reading. The history-list "abnormal only" filter matches the
  same way (`entry_id === event.id`).

## Instrumental-test entries

- `add-entry.tsx` offers the third AI document type, `instrumental_test`
  ("Instrumental Test (MRI, Elastography, ECG...)"). Extracted
  `instrumental_data` is edited in `InstrumentalTestForm.tsx`, whose
  `MODALITIES` select is the **fixed** list — MRI, CT, X-Ray, Ultrasound,
  Elastography, Mammography, PET Scan, ECG, Endoscopy, Other — the backend
  extractor is constrained to the same values.
- Biomarker rows belong to blood tests only: `buildSaveEntryFormData` sends
  `biomarkers` only when `documentType === 'blood_test'`, and the Document
  Type select's `handleDocumentTypeChange` clears stale extracted
  categories/visit/instrumental state, so a switched entry can never persist
  leftover readings or the wrong structured payload.
- Timeline details: `TimelineView` renders `InstrumentalTestDetails.tsx`
  (modality, findings, conclusion, attachments, Settings tab with Delete) for
  `instrumental_test` events, fed from the timeline response's `instrumental`
  map keyed by entry id.

## Auth pages & password reset

- Public pages under `src/app/`: `login`, `register`, `forgot-password`,
  `reset-password`. No middleware guards routes; auth is enforced server-side
  via `get_current_user_or_anon` on data endpoints.
- `/forgot-password` posts to `/api/auth/forgot-password` (proxied); on success
  it shows a static confirmation (the backend never reveals whether the email
  exists). `/reset-password` reads `?token=` from the URL, validates a new
  password client-side (min 8 chars, mirroring register), posts to
  `/api/auth/reset-password`, and offers a link back to `/login`. Both pages
  follow the login/register Card layout and go through the server-side proxy.

## Settings tab

- `frontend/src/components/health-passport/entry-settings.tsx` — third tab
  inside `BloodTestDetails` and `DoctorVisitDetails` (next to Documents).
- Surfaces entry-level stats (type, date, age, document count + total size,
  biomarker counts by status for blood tests, notes/Rx/recommendation counts
  for visits, copyable entry ID) and a Danger Zone with a destructive Delete
  button + Radix Popover confirm dialog.
- The view-level `TimelineView` passes an `onDeleted` callback that clears the
  local selection and refetches the timeline.

## Settings page (`/settings`, Account & Data)

- `views/SettingsView.tsx` composes four cards from
  `components/health-passport/settings/`: `profile-card`, `usage-card`,
  `data-export-card`, `danger-zone-card`. Entry point: a **Settings** item in
  the header user dropdown (`header-bar.tsx`, next to Sign out — registered
  users only; anonymous sessions have no dropdown and reach `/settings` by
  URL). The view has a ghost "Back to Dashboard" sub-nav bar (reusing
  `misc.backLinks.dashboard`, leave-guard routed, same pattern as
  `PrintSetupView`), and the header logo block is a button that navigates
  to `/` through the same leave-guard (`header.home` aria-label).
- Auth state comes from `AuthStatusProvider` via the view — cards receive
  `status`/`user`/`anonId` as props (no context lookups inside cards, so
  tests render them directly without provider mocks).
- **Profile card**: registered → name/email/dob/gender rows (gender labels
  reuse the `header.gender*` keys); anonymous → explainer + Register CTA
  (router.push — this project's `Button` has no `asChild`) + session id.
- **Usage card**: renders `fetchUsageLimits()` — AI extractions and storage
  as progress bars ("{used} of {total} used", `Limit reached` when a meter is
  exhausted). This is the ONLY place quota is surfaced proactively; upload
  flows still learn limits reactively via 429 toasts. `formatBytes` is
  shared from `entry-settings.tsx` (exported there).
- **Data-export card**: `downloadAccountExport('json' | 'csv')`
  (`services/api.ts`) — authenticated fetch of `GET /api/export` through the
  proxy (a plain anchor cannot send the Authorization header), then blob →
  anchor download. Filename from the backend's `Content-Disposition`, else a
  dated fallback (`healthpassport-backup-YYYYMMDD.json` /
  `healthpassport-readings-YYYYMMDD.csv`). Errors toast via sonner.
- **Danger zone card**: registered users get the change-password form
  (client-side mismatch + ≥8-char checks mirroring register/reset; backend
  errors surface through `ApiError.message` — the server's localized
  detail) and a Popover-confirmed **Delete account** (same destructive
  pattern as `entry-settings.tsx`) which calls `deleteAccount()` then
  `signOut({ callbackUrl: '/' })`. Anonymous users see only session-data
  deletion, which ends with `window.location.assign('/')` — a full reload
  onto the fresh anonymous session the backend's cookie-clear provides.
- i18n: the `settings` tree lives in `src/i18n/messages/settings.ts`
  (en/ru parity auto-guarded); the header gear label is `header.settings` in
  `shared.ts`. Tests: `src/components/__tests__/settings-cards.test.tsx`
  (mocks `@/services/api`, `next-auth/react`, `next/navigation`) and
  `src/services/__tests__/export-download.test.ts`.

## UI localization EN/RU (next-intl, cookie-driven)

- **No URL-based locale routing.** The locale lives ONLY in the `NEXT_LOCALE`
  cookie (`en` | `ru`), read server-side by `src/i18n/request.ts`
  (registered via `createNextIntlPlugin` in `next.config.mjs`). First visit
  sets the cookie from `navigator.language` (inline bootstrap script in
  `app/layout.tsx`, which reloads once when a Russian browser lands on the
  English-rendered page). `app/layout.tsx` also drives `<html lang>` and the
  message set from the cookie; all routes are therefore Dynamic.
- `LanguageSwitch` (`src/components/shared/language-switch.tsx`, `EN | RU`)
  sits in the header bar and on all four auth pages. It writes the cookie via
  `setLocaleCookie()` in `src/i18n/api-locale.ts` and calls
  `router.refresh()` — the server tree re-renders with the new locale while
  client state survives.
- Message catalogs: per-domain TS modules in `src/i18n/messages/`
  (`shared/auth/addEntry/timeline/correlation/print.ts`), each exporting
  `{ en, ru }` trees merged by `index.ts`. RU plurals use ICU
  one/few/many/other with the `count` param. `src/i18n/__tests__/messages.test.ts`
  guards en/ru key parity, non-empty values, and param consistency.
- **Backend error text is localized server-side**, not in the browser:
  `services/api.ts` sends `Accept-Language: <locale>` on every API call
  (`baseHeaders()`), and the backend returns localized `detail`/SSE messages
  (see `backend/docs/architecture.md`). `api-locale.ts` additionally carries
  the few frontend-side ApiError fallback strings (`apiFallback()`) — its
  English values are pinned by `api-error-detail.test.ts`.
- Dates: `formatDate`/`splitDateLabel` in `lib/utils.ts` take a `locale` param
  (call sites pass `useLocale()`); the connector (" at " / " в ") is shared so
  the reverse-parse in `splitDateLabel` stays in sync. Status enums render
  through `localizedStatus()` (`lib/status-labels.ts`), never raw.
- Tests: components under test need the i18n context — wrap renders with
  `TestI18nProvider` (`src/test/i18n-test-provider.tsx`, English by default,
  so all English assertions pass unchanged).
- **Still English by design**: pydantic 422 validation text, catch-all SSE
  `str(e)` errors, DB-persisted entry titles/categories, flowsheet date-column
  labels ("May 26" — server-formatted and embedded in composite ids), the
  printed document's language maps in `print-editor.tsx` (those localize the
  DOCUMENT per its target language, independent of the UI locale), and
  technical identifiers (modality values, `EN` badges). Unit strings and
  qualitative values are NOT in this list anymore — they are translated at
  display time for `ru` (see the display-time RU translation section).
