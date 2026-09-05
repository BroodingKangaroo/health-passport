# Batch import with background extraction jobs — tickets

Feature breakdown for the async extraction system: a new user with 10–20
documents imports them in one sitting; the server extracts in the background
while the user is free to leave; finished documents pop notifications (top-right
bell) that lead to the existing review editor, and a dedicated **imports
tracker page** lists every extraction with live progress (clicking a job opens
the extraction-process view or, when done, the review editor). Nothing is
persisted without user review.

Companion to `docs/product-roadmap.md`. Architecture references:
`backend/docs/architecture.md`, `frontend/docs/architecture.md` (updated by
tickets A6/B5 in the same change).

## Locked product decisions

| Decision | Choice |
|---|---|
| Review policy | **Staged results only** — a finished job holds the extracted record + file; the entry is created only when the user reviews and saves in the existing editor. No auto-save, no post-save editing needed. |
| Delivery | **Notification system** — per-user `notifications` table + API; bell icon top-right in the header; toast pops when a document finishes; click → review page. |
| Progress tracking | Dedicated **`/imports` tracker page** listing every job with live status; clicking an in-flight job opens the extraction-process view (existing upload-screen visuals driven by job progress), clicking a done job opens the review editor. The bell stays the lightweight surface; the tracker is the full cockpit. |
| Anonymous quota | Stays **5 extractions lifetime** (config). Batch UI shows the limit up front and blocks beyond it; registration (50 quota) is the path to bigger imports. Anon→register migration carries staged jobs + notifications. |
| Concurrency | **1 worker** by default (serial Mistral calls — avoids the documented 429-contamination bug); env knob `IMPORT_WORKERS` reserved for later. |
| SSE `/api/extract` | **Untouched** — single-document fast path and the e2e golden harness keep working as-is. |

## Architecture summary

- **`ExtractionJob`** (new table, `create_all`): `id, user_id (idx), status
  (queued|processing|done|failed|cancelled), stage, progress JSON (same payloads
  as SSE progress events incl. `estimate_s`), result JSON (StandardizedMedicalRecord
  dump, nullable), error_key/error_params (nullable — resolved via backend i18n at
  read time; the worker thread has no locale), original_filename, file_path
  (UPLOAD_DIR, uuid name), file_size, created_at, updated_at.
- **Worker** (`app/services/extract_jobs.py`): module-level `queue.Queue` +
  daemon threads; re-runs the `/api/extract` pipeline with its own session
  (sessionmaker **injection seam** — the worker takes the app's sessionmaker
  rather than a hardcoded global, so tests point it at the test engine);
  match stage MUST commit before close / rollback on error — the #1 documented
  invariant (with a regression test). Reuses `timing_stats` so estimates stay
  live; refunds quota on failure or user cancel, never on client disconnect
  (there is none). **Refund authority**: only the worker refunds a job it has
  dequeued; API-side cancel/retry refund/charge only via CAS status
  transitions (see A4). **Single-process constraint**: the queue is
  per-process — a startup guard asserts it and A6 documents it; boot recovery
  re-enqueues orphaned `queued` rows and fails+refunds orphaned `processing`
  rows (CAS-guarded, emitting the failed notification).
- **DB concurrency**: the worker adds a background writer next to request
  traffic — enable SQLite WAL + `busy_timeout` in `session.py`, and the compose
  volume must become a directory mount (today `backend_db:/app/health_passport.db`
  pins the bare file, so WAL/journal sidecars would not persist).
- **`Notification`** (new table, same DB — a second database file would
  complicate sessions/migrations for zero benefit): `id (uuid), user_id (idx),
  type (`import_job_done`|`import_job_failed`), payload JSON ({job_id,
  filename}), read_at (nullable — unread = `read_at IS NULL`), created_at (idx).
  Exactly one row per job terminal transition, written atomically with the job
  status change; cancelled jobs emit nothing.
- **Quota**: charged at job submit (same `check_and_record_ai_usage` semantics,
  committed after file validation); refunded on failure/cancel. Storage quota is
  NOT charged at submit — only when the reviewed entry saves and the file
  becomes an `Attachment`; unsaved/expired staged files cost the user nothing.
  A per-user cap on pending work (concurrent non-terminal jobs + staged bytes,
  config) bounds the worst case (~50 jobs × 20MB staged with zero storage
  charged).
- **Expiry/GC**: staged results + files expire after 72h (config); lazy sweep on
  enqueue + list-read; reuses `unlink_unreferenced_files`.
- **Save**: `POST /api/entry` gains optional `import_job_id` — creates the
  Attachment from the staged file (no re-upload), charges storage, deletes the
  job row.
- **Tracker page** (`/imports`): polls the same jobs list; done jobs disappear
  naturally when saved or dismissed (the job row is deleted), so the page
  always shows actionable work + in-flight/failed items.
- **User time**: ~N docs ≈ N × ~25s of server time (serial worker); the user
  browses/leaves freely.

---

## Phase A — Backend

### A1 · `ExtractionJob` model, startup recovery, expiry GC, DB infra — S/M

- Add the model (spec above) to `app/db/models.py`; `create_all` covers new
  tables (no `migrate_add_columns` needed).
- **Startup recovery** in the `init_db` path, both orphan states:
  - `processing` rows at boot → `failed` via CAS
    (`UPDATE … WHERE status='processing'`), refund + emit the failed
    notification through the same helper the worker uses (a user who left
    during a crash must still learn the doc failed);
  - `queued` rows at boot → **re-enqueue into the fresh queue** (the in-memory
    queue died with the old process; without this they sit "waiting" until GC
    with quota burned).
- **Single-process guard**: at startup, register/assert the job-service
  singleton (pid check) — a second app process against the same DB is a
  misconfiguration that must fail loudly, not corrupt state (worker-A running
  while worker-B "recovers" its rows).
- **GC** (`IMPORT_JOB_TTL_H=72`, config): a **global** sweep (never
  caller-scoped — that would leak dead users' files) called lazily from the
  API layer (enqueue + list-read), no scheduler; deletes row + file
  (`unlink_unreferenced_files`) **and the job's notification rows** (the bell
  must never offer "Review" on a 404'd job). Save (A5) claims the job via CAS
  before commit so a sweep can never unlink a file mid-save.
- **DB infra**: enable WAL + `busy_timeout` in `app/db/session.py`; change
  `docker-compose.yml` to mount the DB **directory** (sidecar files persist).
- Tests: model defaults, recovery of both orphan states (refund exactly once,
  notification emitted, re-enqueued job resumes), guard trips on second
  process, GC removes expired row + file + notification and leaves live ones.

### A2 · Worker service `app/services/extract_jobs.py` — L

- `queue.Queue` + daemon worker thread(s) started lazily on first enqueue;
  `IMPORT_WORKERS` env knob (default 1).
- **Sessionmaker injection seam**: the worker receives the session factory
  (module-level, settable in tests) — its own `SessionLocal()` calls would
  otherwise bypass the per-test in-memory engines and silently test the wrong
  database (`tests/conftest.py` overrides `get_db`, not globals).
- Pipeline reuses the exact `/api/extract` stages: read file bytes from disk →
  `extractor.ocr_document` → `extractor.llm_extract` → `detect_source_language`
  → definitions query (global + user + system-shared, same as `ai.py`) →
  `matcher.match_and_convert` in the worker's own session with
  **commit-before-close / rollback-on-error** → store `result.model_dump()`,
  `status=done`.
- **`entry_type:"unknown"` is a SUCCESS, not a failure** (mirrors the SSE path,
  `ai.py:549-566`): `status=done` with the result payload, **no refund** — the
  LLM genuinely ran and the user gets the unknown-editor.
- Progress writes: update the job row (`stage`, progress JSON) at each stage
  transition + `timing_stats.record` — same calls as the SSE path.
- Failure: `status=failed` + `error_key`/params (localized at read time, same
  pattern as `ai.py`), refund quota, emit the failed notification. Unexpected
  exceptions → failed + refund (never crash the worker loop).
- Cancel flag: checked between stages; worker-side cancel → refund + delete
  staged file (the worker owns refunds for anything it dequeued — the API
  never refunds a non-queued job).
- Terminal transitions insert the `Notification` row (A3) in the same commit
  as the job status change; cancelled emits nothing.
- Tests: full lifecycle with mocked OCR/LLM/matcher (pattern of the existing
  `/api/extract` tests) **against the injected test session**, progress rows
  written per stage, failure refund, cancel-between-stages, unknown-type done
  without refund, notification emitted exactly once per terminal transition,
  and a regression test that definitions created by `verify_or_create` survive
  the worker session close (the commit-before-close invariant).

### A3 · `Notification` model + API — M

- Model (spec above) in `app/db/models.py`.
- Router `app/api/notifications.py`:
  - `GET /api/notifications` → `{unread_count, items[≤50 newest]}` (tenant-scoped).
  - `POST /api/notifications/{id}/read` → sets `read_at` (idempotent; foreign id → 404).
  - `POST /api/notifications/read-all`.
  - `DELETE /api/notifications/{id}` → dismiss. Dismissing does NOT delete the
    staged job — it expires via GC on its own.
- Emission lives in the worker (A2): one row per `done`/`failed` transition.
  Payload minimal: `{job_id, filename}` — human-readable error detail resolved
  on demand from the job-detail endpoint (server-localized), never stored in
  the notification.
- Anonymous principals participate like everywhere else (bell works for anon's
  ≤5-doc imports).
- Anon→register migration: `copy_anonymous_data` re-keys Notification **and**
  ExtractionJob `user_id` (same one-statement pattern as `UsageLimit`;
  implemented in A5 — a staged job must stay reviewable and its failure refund
  must hit the registered counter after registration).
- Tests: list/unread counts, mark-read idempotency + tenant scoping, read-all,
  dismiss, migration re-keys rows (A5).

### A4 · Import-jobs API router `app/api/import_jobs.py` — L

- `POST /api/import/jobs` — one file per call (frontend loops): same validation
  as `/api/extract` (filename, 20MB cap, ext allowlist), charge quota committed
  after validation, save file to `UPLOAD_DIR`, create row, enqueue, run GC →
  `{job_id}`. 429 with the existing localized limit detail (anon's 6th doc).
  Also enforces the **per-user pending cap** (concurrent non-terminal jobs +
  staged bytes, config — bounds the uncharged-storage worst case) with its own
  localized 429.
- `GET /api/import/jobs` — caller's non-expired jobs, compact fields
  (id/status/stage/progress/filename/error) → batch page polling.
- `GET /api/import/jobs/{id}` — full record incl. `result` when done; **same
  shape as the SSE result event** so the existing form-fill code consumes it
  unchanged; localized error message for failed.
- `POST /api/import/jobs/{id}/cancel` — **CAS transition**: refund + file
  delete only when `UPDATE … WHERE status='queued'` affects 1 row (a job the
  worker already dequeued is the worker's to cancel — flag it instead);
  processing → flag for the worker.
- `POST /api/import/jobs/{id}/retry` — **CAS transition** failed→queued:
  validate the file is still on disk, re-charge quota (only on the winning
  UPDATE), reuse the job row. Backs tracker/bell "Retry" without a fresh
  upload; the LLM genuinely runs again.
- `DELETE /api/import/jobs/{id}` — dismiss done/failed (delete staged file +
  row + **all** notification rows for the job — retries can have produced
  several).
- All user-facing strings via `i18n.tr`; tenant-scoped 404s (no info leak).
- Tests: quota charged at submit / refunded on failure, 429 paths (quota +
  pending cap), validation errors, tenant scoping, enqueue→poll→result happy
  path (mocked stages), CAS cancel loses the race against a dequeuing worker
  without refunding, retry re-charges only via the winning transition and
  rejects non-failed jobs, dismiss cascades all notifications.

### A5 · Save/merge-with-job-id + anon→register migration — M

- `save_entry` optional `import_job_id` Form field: ownership + `done` + not
  expired; **claims the job via CAS** (`done → saving`-style transition in the
  same transaction) so the GC sweep can never unlink the file mid-save;
  `Attachment` created from the staged file (keep the on-disk file, new row via
  the `_save_attachment` contract — size/type/name from the stored file),
  **storage quota charged here**, job row deleted in the same commit.
- `POST /api/entry/{id}/merge` gains the same `import_job_id` option — a batch
  review hitting a same-date entry merges the staged record into it (same
  staged-file/attachment/conflict semantics as the file-upload merge path;
  see B4's same-date strategy).
- Failure mid-save/merge rolls back cleanly and the job stays `done` (file
  still staged — retryable).
- **Anon→register migration**: `copy_anonymous_data` re-keys
  `ExtractionJob.user_id` **and** `Notification.user_id` (one-statement
  pattern, same as `UsageLimit`) — staged jobs stay reviewable and refunds hit
  the registered counter after registration.
- Tests: save creates entry + attachment + charges storage + deletes job;
  foreign/expired/queued job ids rejected; CAS claim blocks a concurrent GC;
  merge-with-job-id happy + 409 conflict path; migration re-keys jobs +
  notifications and a post-registration staged job is reviewable/refundable.

### A6 · Backend docs + invariants — S

- `backend/docs/architecture.md`: new section (job model, worker, endpoints,
  notifications, expiry, startup recovery, migration).
- `AGENTS.md` invariants: quota at submit for jobs (refund on fail/cancel, never
  on disconnect), staged results expire, SSE endpoint unchanged (harness
  untouched), notifications are per-user rows written atomically with job
  transitions, refund/charge authority rules (worker for dequeued jobs, CAS
  transitions for API-side actions).
- **Single-process constraint documented**: the worker queue is per-process —
  `uvicorn --workers N` or a scaled backend container is unsupported and
  guarded at startup; raising it later requires a real broker + lease-based
  recovery.
- **Rate-limit overlap**: a batch worker and an interactive single-doc SSE
  extraction can run concurrently — two Mistral consumers; acceptable (SDK
  retries + refunds bound it) but stated. `IMPORT_WORKERS>1` stays forbidden
  until a rate-limit strategy (per-worker clients or serialized calls) exists.

### A7 · Observability + funnel metrics — S/M

- Structured job-lifecycle logging mirroring the SSE path's per-stage
  `logger.info` discipline (job id, user, stage, durations) — the pipeline's
  latency regressions must stay diagnosable without an SSE stream.
- **Funnel counters** (the feature's motivation is conversion — measure it):
  an `import_funnel_events`-style record per transition (`submitted`,
  `extracted`, `reviewed`→saved, `failed`) or equivalent counters, so
  "docs imported per new user" and "review completion rate" are answerable
  before deciding whether a review fast-track is ever needed.
- Tests: counters written per transition, no rows on cancelled jobs.

## Phase B — Frontend

### B1 · API client + batch import UI — L

- `services/api.ts` (or `services/import-jobs.ts`): `createImportJob(file)`,
  `fetchImportJobs()`, `fetchImportJob(id)`, `cancelImportJob(id)`,
  `dismissImportJob(id)` — `Accept-Language` on every call, through the proxy.
- `add-entry.tsx`: dropzone accepts multiple files; >1 file → batch mode:
  per-file rows reusing the upload-screen stage visuals (stage label + countdown
  from `estimate_s`), overall progress, per-row cancel, retry-on-fail + remove.
- Pre-flight anon notice: "up to 5 documents without an account — register to
  import more" with remaining-quota counter (`fetchUsageLimits`).
- **Submission is capped, not shotgun**: submit `min(N, remaining)` jobs; files
  beyond the limit render as a disabled "register to import" group with a
  register deep-link (anonymous at 5, registered near 50 — same logic from the
  fetched limits). No fire-all-and-eat-429s: files the user never submitted
  stay picked for after registration.
- Submit fires the capped N `POST /api/import/jobs`; polls
  `GET /api/import/jobs` every ~3s while the page is open.
- **Leave-guard: NOT armed in batch mode.** Nothing is lost by leaving — the
  extraction continues server-side — so the guard's Back interception and
  navigation modal would be pure friction. Only a `beforeunload` prompt while
  submissions are still in flight (uploads not yet accepted). The armed
  guard+abort behavior stays exclusive to the single-file SSE path.
- Single-file flow stays exactly as today.
- Vitest: batch list rendering + stage transitions, quota notice + capped
  submission + disabled group, cancel/retry, beforeunload semantics.

### B2 · Notification service + bell + toast — M

- `services/notifications.ts`: `fetchNotifications()`, `markRead(id)`,
  `readAll()`, `dismiss(id)`.
- `NotificationBell` in `header-bar.tsx` (right of language switch / user menu;
  visible for anon too): react-query `['notifications']` polling every ~10s +
  refetch on window focus (iOS Safari suspends JS in background tabs — all
  catches-up toasts would fire on resume).
- Badge = unread count; **toasts are coalesced**: >1 newly-arrived unread
  `import_job_*` notification → ONE summary toast ("3 documents extracted —
  review") linking to `/imports`; a single new one toasts individually with a
  review deep-link. No toast storms on tab resume.
- Dropdown list: done → "Review", failed → "Retry"/"Dismiss", processed items →
  mark read. Error detail (if shown) fetched from the job endpoint
  (server-localized). Footer link → `/imports` tracker page (B3).
- Seen-state: badge clears on open + mark-read/read-all; no localStorage
  bookkeeping beyond what mark-read covers.
- Vitest: bell badge/poll, toast-on-new, dropdown actions.

### B3 · Imports tracker page `/imports` — M

- New view (`ImportsView` + tracker list component): every caller job with
  filename, status, stage + countdown (queued → "waiting", processing → stage
  visuals + `estimate_s`, done, failed → localized error, cancelled), sorted
  newest-first; polls `GET /api/import/jobs` every ~3s while open (shares the
  B1 polling hook — one cache key, so the batch page and tracker stay in sync).
- **Click behavior**:
  - done → `/review-import?job=<id>` (review editor, B4);
  - queued/processing → per-job extraction-process view: the **existing
    upload-screen stage visuals** (spinner, step N of 3, countdown) driven by
    the job's live progress instead of the SSE stream; when the job completes
    in view, transitions into the review editor — same experience as the
    current extraction flow, just resumable;
  - failed → inline error + Retry (`POST /api/import/jobs/{id}/retry`, A4) +
    Dismiss; queued/processing → Cancel.
- Entry points: bell dropdown footer link ("View all imports"), the batch
  completion state on `/add-entry` ("Track remaining extractions"), and
  NavBar-consistent back navigation.
- Empty state: "no documents in progress — import one" → `/add-entry`.
- History semantics: saved jobs are deleted server-side (save consumes the
  staged job), so the page shows only actionable work + in-flight/failed items
  — no stale history to manage.
- Vitest: list statuses, click-through wiring (done→review, processing→progress
  view), retry/cancel/dismiss actions, shared-poll cache sync with the batch
  page.

### B4 · Review page `/review-import?job=<id>` — M

- Fetches the staged `StandardizedMedicalRecord` → prefills the **existing
  add-entry editor machinery** (same `onSuccess` fill path, unit-conflict
  dialog, merge checkbox, document-type editors — all derive from the staged
  record exactly as they do from the SSE result today).
- Save → `POST /api/entry` with `import_job_id` (no file re-upload) → toast →
  auto-advance to the next done job (if any); "leave for later" → back, job
  stays in the bell.
- **Same-date strategy for a batch**: when the parsed date already has an
  entry (or another done staged job), the editor shows the same-date hint;
  merging into an existing entry submits `POST /api/entry/{id}/merge` with
  `import_job_id` (A5). Review sequentially — saving job A first, then
  merging job B into it — mirrors today's upload-then-merge flow without a
  re-upload. Two staged same-date jobs that should stay separate save as
  separate entries (existing conflict warnings apply).
- Failed/expired job → honest error + dismiss; unknown id → back to timeline.
- Vitest: prefill wiring, save-with-job-id + merge-with-job-id call shapes,
  auto-advance, error states, same-date hint.

### B5 · i18n catalogs + frontend docs — S

- New keys (`notifications`/`import`/`review`/`tracker` trees) EN/RU parity via
  the existing test; no rewording of pinned EN values.
- `frontend/docs/architecture.md`: batch UI, bell, tracker page, review page,
  leave-guard change.

## Phase C — Hardening

### C1 · Resilience sweep — S/M

- Startup-recovery integration tests (kill mid-run simulation): orphaned
  `processing` fail+refund+notify, orphaned `queued` re-enqueue and complete;
  CAS refund-ownership contract (cancel losing the race to the worker never
  refunds; retry re-charges only on the winning transition; no double refund;
  nothing refunded after `done`); expiry sweep vs. a concurrent save (CAS
  claim wins); per-user pending cap under a batch; double-submit of the same
  job id; save/merge retry after a failed save.
- Backend: `venv/bin/ruff check .` + `python -m pytest tests/ -v` green.

### C2 · Regression + harness verification — S

- Golden harness untouched: run `validate_offline.py` / one manual e2e case to
  confirm `/api/extract` SSE still behaves.
- Frontend: `pnpm lint` + `pnpm test` green.

---

## Known trade-offs (accepted, measured)

- **Residual review cost**: "nothing saved without review" keeps today's
  contract, so the user's *active* time after a 15-doc batch is still ~15
  editor visits (date check, unit-conflict dialog, save) — the feature removes
  the blocked waiting and the upload ceremony, not the review. A7's funnel
  counters exist precisely to measure whether this remains a drop-off point;
  an auto-save + post-save-editing fast-track is the explicit next step if it
  does (out of scope here).
- **Batch + interactive extraction overlap** can hit Mistral account rate
  limits (429s) — SDK retries and the refund path bound the damage; documented
  invariant, not a bug.
- **SQLite is the concurrency substrate** for worker + request writes — WAL +
  busy_timeout make it adequate at this scale; a real broker/Postgres is the
  answer only if multi-process or much larger volume is ever required.

## Out of scope (this feature)

- Post-save entry editing (review happens before save, via the existing editor).
- Parallel workers >1 (knob reserved; needs a rate-limit strategy first).
- Notification channels beyond in-app (email/push later).
- e2e golden-harness changes (SSE path unchanged).

## Suggested order & rough sizes

A1 → A2 → A3 → A4 → A5 → A6 → A7 → B1 → B2 → B3 → B4 → B5 → C1 → C2
(S ≤ 0.5d · M ≈ 1–2d · L ≈ 2–3d; total ≈ 7–10 dev-days)
