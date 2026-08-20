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
- Dev: `pnpm dev` (port 3000). Lint: `pnpm lint`. Unit tests: `pnpm test` →
  `vitest run`, jsdom env, `@/` → `src/` alias.
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
  (one batched LLM call per language) BEFORE navigating to `/print-editor`;
  the button shows "Translating terminology…" while it runs.
- The backend persists translations into the definition's `names[lang]`
  column (see `backend/docs/architecture.md`), so `print-editor.tsx`'s
  `translatedName()` — which reads `def.names[lang]` via the flowsheet's
  per-definition `names` — renders them with no renderer changes. Repeated
  generates are free (server-side short-circuit; the backend never re-charges
  quota for already-translated names).
- Translation failures never block export: the document proceeds with English
  names and a toast explains why. The `original` mode and `en` target skip the
  translation call entirely.

## Reference formatting / stats

Mirror of the backend's reference model (see `backend/docs/architecture.md`):

- `frontend/src/lib/reference.ts` — `formatReference`, `intervalBounds`,
  `isOutsideReference`.
- Manual entry sends a structured `reference` object per row (not a range
  string); `frontend/src/components/health-passport/reference-input.tsx` is
  its interval editor.

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
  value, qualitative 0/1 → 0/100.
- Suggested-pair threshold: **n ≥ 5 shared readings and |r| ≥ 0.5** — the
  n≥5 floor keeps tiny samples (where a perfect fit is trivial) from flooding
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
  `original_name/value/unit/range` and `reference`, so an older event shows
  the metadata of the reading at that event (matching its save-time status),
  not the newest doc's. The history-list "abnormal only" filter matches the
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
