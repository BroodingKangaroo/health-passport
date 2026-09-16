# Phase 1.1 — Shareable read-only link (technical plan)

**Status:** draft for owner review. The product decisions live in
`docs/phase-1.1-product-plan.md`; this plan implements them.
**Date:** 2026-09-16.
**Source:** `docs/product-roadmap.md` §1.1, `docs/phase-1.1-product-plan.md`
(§3 data, §6 D1–D15, §7 live-link, §8 language/copy, §9 trust, §13 build
order), constrained by the AGENTS.md invariants.
**Scope:** design only. No code, tests, migrations, endpoints or components are
written here; model fields, endpoint shapes, token handling and a test plan
are. Where the product plan forces a worse technical shape, §18 says so.

---

## 1. What this implements

A registered or anonymous principal creates a link to their own record. A
stranger with the link opens a public page, with no account, and reads the
record as it is at that moment. The owner can revoke; every link expires.

Nothing resembling this exists today. Every read endpoint in
`backend/app/api/` resolves a principal through `get_current_user_or_anon`
and filters by that principal's `patient_id`. There is no second way in. This
plan adds exactly one, and keeps it to one.

---

## 2. Shape of the change

```
owner (JWT or anon cookie)                 recipient (nobody)
        |                                          |
        |  POST /api/share/links                   |  GET /s/<token>     (Next page)
        |  GET  /api/share/links                   |        |
        |  POST /api/share/links/{id}/revoke       |        |  GET /api/share/record
        v                                          v        |  X-Share-Token: <token>
+---------------------------------------------------+       |
|  /api/share/*                                     |<------+
|    sender routes  -> get_current_user_or_anon      |
|    public routes  -> resolve_share_context(token)  |
|                          |                         |
|                          v                         |
|                   owner_id + scope                 |
+---------------------------------------------------+
                           |
                           v
        existing builders: _events_from_db, _build_flowsheet,
        _serializers.result_schema / reading_schema / definition_schema
```

Two rules carry the whole design:

1. **`resolve_share_context` is the only place a client-supplied string
   becomes a tenant id.** It is the one function that maps an unauthenticated
   request to an owner. Everything else in the public router receives an
   already-resolved context and cannot widen it.
2. **The public surface is GET-only and reads only its own router.** No
   existing endpoint gains an alternative auth path, so no write endpoint is
   one dependency-swap away from being public.

---

## 3. Data model

### 3.1 `share_links`

One new table, `ShareLink`, added to `backend/app/db/models.py`.

| Column | Type | Null | Purpose |
|---|---|---|---|
| `id` | String PK | no | `uuid4().hex`. Sender-side handle: the list, revoke, and revoke-all address a link by `id`, never by token. |
| `token_hash` | String, **unique index** | no | SHA-256 hex of the raw token. The only stored form. The unique index is what makes the public lookup a single indexed point read. |
| `owner_id` | String, index | no | The owning principal: a `Patient.id` (uuid hex) **or** an `anon-…` id. One column, not a pair. |
| `is_anonymous` | Boolean, default `True` | no | Mirrors `ExtractionJob.is_anonymous` / `UsageLimit.is_anonymous` / `ImportFunnelEvent.is_anonymous`. Drives the 7-day cap and the "this link belongs to a browser session" copy. |
| `scope` | JSON | yes | `null` = whole passport. Range = `{"kind":"range","from":"2026-03-01","to":"2026-09-01"}`. |
| `include_header` | Boolean, default `True` | no | D6. |
| `include_notes` | Boolean, default `False` | no | D4. |
| `default_locale` | String | yes | The sender's optional preset (D7). Stage 3; null otherwise. |
| `created_at` | DateTime, default `now(utc)` | no | |
| `expires_at` | DateTime(tz) | no | Always set. There is no unlimited link (D10), so this is never null. |
| `revoked_at` | DateTime(tz) | yes | Null = not revoked. |
| `first_opened_at` | DateTime(tz) | yes | First successful public read. Sender-visible (D14). |
| `last_notified_entry_at` | DateTime(tz) | yes | New-data-notice watermark, §8.3. |

**Why one `owner_id` and not `patient_id` + `anon_id`.** Every principal-keyed
table in this repo already stores a single string id that is either a
`Patient.id` or an `anon-…` value (`MedicalEntry.patient_id`,
`ExtractionJob.user_id`, `Notification.user_id`, `UsageLimit.user_id`). A
two-column owner would be the only table that needs an "exactly one of these
is set" invariant, and the codebase has no CHECK-constraint precedent
anywhere. The `is_anonymous` boolean carries the one fact the pair would have
made structural, and it is already the house pattern.

**Why `scope` is JSON and not two `DateTime` columns.** The product's range is
"a from/to pair in whole months" (D2), and the eventual shape (D2 deferral,
per-entry scope) is not settled. JSON with a `kind` discriminator is the
`reference` model's established pattern and keeps the row extensible without
a migration; one helper, `scope_bounds(link) -> (datetime | None, datetime |
None)`, is the only reader. The cost is that the scope filter is applied in
Python after the entries query, not in SQL — acceptable for a single owner's
record.

### 3.2 Migration

`share_links` is a **new table**, so `Base.metadata.create_all` creates it on
the next boot with no change to `migrate_add_columns()` in
`app/db/session.py`. That is the whole migration for v1: no data backfill, no
existing row is touched, and a long-lived DB picks the table up on restart.
Any column added to this table after it ships goes through
`migrate_add_columns()` like every other column.

### 3.3 Lifecycle events that touch the row

| Event | Effect |
|---|---|
| Anonymous session registers with `migrate_data` | `copy_anonymous_data` **re-keys**: `UPDATE share_links SET owner_id = <new patient id>, is_anonymous = false WHERE owner_id = <anon id>`. |
| Registered account deleted | The `DELETE /api/auth/account` cascade deletes the principal's links. |
| Anonymous session deleted | Same cascade, plus the existing cookie clear. |
| Anonymous cookie lost (not deleted) | No row change. The link lives until `expires_at` and nobody can revoke it. |
| Expiry passes | No row change. Expiry is evaluated at read time; the row stays as history. |
| Revoke | `revoked_at = now`. |

**Re-key, do not leave the link on the anon id.** `copy_anonymous_data` copies
entries under new ids and leaves the anon rows in place. A link still pointing
at the anon id would keep serving the frozen anonymous copy — the recipient
would watch a record that stopped changing the day the sender registered,
while the sender's real record moved on. Re-keying matches what
`ExtractionJob` and `Notification` already do
(`.update({"user_id": new_user_id})`), keeps the sender's revoke power after
registration, and is cheap: one statement, inside the same transaction as the
copy. `data_migration.py` is not owned by another thread, but the change must
respect the register path's atomicity — the register endpoint already calls
`copy_anonymous_data(commit=False)`.

**No garbage collector.** Expired links are not swept. The product wants the
sender's list to show expired links forever (§5.4), the rows are tiny, and a
sweep would mean a background job — which is exactly the thing the
single-process constraint makes expensive (§17.1). Nothing here participates
in the import queue.

### 3.4 Indexes

- `token_hash` unique — the public read path.
- `(owner_id, created_at DESC)` — the sender's list, newest first.
- Nothing on `expires_at`: nothing scans by it.

---

## 4. Token handling and transport

### 4.1 Generation

`hp_` + `secrets.token_urlsafe(32)` — 256 bits of entropy, ~46 characters.

The prefix is deliberate: it makes the token identifiable to secret scanners,
grep-able in an incident, and versionable if the format ever changes. The
token is generated once, returned in the create response, and never stored in
raw form.

### 4.2 Storage

SHA-256 hex of the raw token in `token_hash`, exactly as
`PasswordResetToken.token_hash` and `EmailChangeToken.token_hash` already do.
A DB leak (backup, `.db` file, a future admin tool) must not hand out live
access to clinical records.

Not bcrypt, and that is not a shortcut: the input is 256 bits of uniform
random, so there is no dictionary or guessing attack for a slow KDF to blunt,
and the lookup happens on every public request — a per-request bcrypt compare
would be a self-inflicted load. The precedent in this repo is the same.

**Consequence to accept, and to write into the copy:** because only the hash
is stored, the sender can never re-open their own link from the list. The raw
URL exists exactly once, in the create response, and it is the sender's
responsibility to send it (which is also the product's model — the sender is
the courier, §5.3). "I lost the link" resolves to "create a new one". The
alternative — storing the raw token, or a decryptable copy — trades a real
security property for a convenience that chat apps already provide, and I
would not take it in v1. If "I lost my link" turns out to be a real support
load, the upgrade is to store the raw token encrypted with `SECRET_KEY` (a
DB-only leak is then useless without the app secret) rather than in plaintext.

### 4.3 Transport: the recipient URL

`https://<frontend>/s/<token>` — the token as a **path segment** on the
frontend route.

A query parameter (`/s?t=<token>`) is equivalent in every log line and every
referrer and strictly worse in appearance: it reads like a tracking parameter
and invites sharing a truncated URL. A fragment (`/s#<token>`) is the only
option that structurally keeps the token out of `Referer` headers, but it
forces the whole record view to be client-rendered — the server never sees the
token — which gives up server-side first paint and server-side locale
resolution on the exact surface where the first 30 seconds are the product.
v1 takes the path segment and pays for it with an explicit `no-referrer`
policy (§12).

### 4.4 Transport: the token to the API

**The token goes in a request header (`X-Share-Token`), not in the API path or
query.** The API paths are constants — `GET /api/share/record`,
`GET /api/share/flowsheet` — so the token appears in no access log, no proxy
log, and no exception log line. The repo has no log-scrubbing layer: whatever
appears in a path is written by uvicorn to stdout and by the app's exception
logger, and is copied into bug reports.

The costs of the alternatives, stated plainly:

- Token in the API path (`GET /api/share/<token>/record`): simpler to curl and
  to cache, and every API log line records a live credential. Rejected.
- Token in the API query string: same logging exposure plus the same
  truncation hazards. Rejected.
- Token in a header: not pasteable into a browser address bar; debugging needs
  curl. Accepted.

The recipient page's own URL does contain the token — it is the link, and that
is unavoidable. The controls that matter there are no-referrer, no-index, and
not writing it anywhere else (§12).

**Sender endpoints are not token-bearing at all.** They authenticate normally
via `Authorization: Bearer` (registered) or the anonymous cookie, and address
a link by its `id`. A sender can list and revoke only their own rows.

### 4.5 What may be logged

- The **link `id`** and the owner id: yes. Both are opaque and already the
  vocabulary of the rest of the app's logs (`[user=…]`).
- The **raw token**: never — not in a log line, an exception message, an
  `HTTPException` detail, a redirect URL, or a metric payload.
- **Anything about the recipient**: never. No IP, no user agent, no referrer,
  no country, no device. The only recipient-derived value the database ever
  sees is the timestamp of the first successful read.

---

## 5. The public read API surface

A new router, `backend/app/api/share.py`, in one file, with two clearly
separated sections.

### 5.1 The enforcement point

```
def resolve_share_context(token: str | None, db: Session) -> ShareContext
```

- Missing/blank header → uniform dead link.
- `sha256(token)` not found → uniform dead link.
- `revoked_at IS NOT NULL` → uniform dead link.
- `expires_at <= now` → uniform dead link.
- Otherwise → `ShareContext(link_id, owner_id, scope_bounds, include_header,
  include_notes)`.

"Uniform dead link" is one response: **404** with one localized `detail`, the
same body for all four cases, and the same for a token that was never issued
as for one that was revoked a second ago (§9 of the product plan). No `410` vs
`404` distinction, no "expired" vs "revoked" wording, no timing difference
worth measuring. The frontend renders the dead-link page from that 404.

On success the resolver records the first open (§8.2) and returns. It is a
dependency (`Depends`) shared by both public GET endpoints, so an endpoint
cannot be added that reads owner data without passing through it.

### 5.2 Endpoints

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET` | `/api/share/record` | `X-Share-Token` | `SharedRecordResponse` |
| `GET` | `/api/share/flowsheet` | `X-Share-Token` | `FlowsheetResponse` |
| `POST` | `/api/share/links` | owner | `ShareLinkCreatedResponse` |
| `GET` | `/api/share/links` | owner | `ShareLinkListResponse` |
| `POST` | `/api/share/links/{id}/revoke` | owner | 200 |
| `POST` | `/api/share/links/revoke-all` | owner | 200 + count |

**`GET /api/share/record`** returns a dedicated envelope that *embeds the
existing wire shapes unchanged*:

```
{
  "meta": {
    "expires_at": "2026-09-22T…",
    "created_at": "2026-09-15T…",
    "last_updated": "2026-09-12T…",
    "scope": {"kind": "all"} | {"kind": "range", "from": …, "to": …},
    "default_locale": "ru" | null
  },
  "header": {"name": …, "dob": …, "gender": …} | null,
  "events":        [ …MedicalEvent… ],     // identical shape to TimelineResponse
  "biomarkers":    [ …BiomarkerResult… ],  // identical shape
  "visits":        { event_id: VisitData },
  "instrumental":  { event_id: InstrumentalData }
}
```

Reusing `TimelineResponse`'s four keys verbatim is the point: the frontend
types (`frontend/src/lib/types.ts`) and the flags/trend/history components
apply to a shared payload with no new parsing and no second vocabulary. The
`meta` and `header` keys are the only additions, and they are the orientation
strip's data.

Two deliberate differences from the tenant-scoped payload:

- `events[].attachments` is always `[]` (§6).
- `biomarkers[].definition` drops `canonical_unit_inferred` (owner-facing
  verification UI, no recipient use). `needs_review` **stays** — D13 requires
  the full table to show the neutral "not standardised" mark, which is a
  rendering decision, not a payload decision.

**`GET /api/share/flowsheet`** returns the existing `FlowsheetResponse`
(`dates`, `matrix`, `biomarkers`) built by the same `_build_flowsheet`,
filtered to the link's scope. It is a separate call so the "All results"
section can load below the fold without weighing down the first paint.

### 5.3 What the shared endpoints must not accept

- No `patient_id`, `user_id`, `owner_id`, or any tenant identifier, ever.
- No scope override: `from`/`to` are read from the link row, so `?from=` is
  ignored. A recipient cannot widen a link.
- No `include_header` / `include_notes` override: those are the sender's
  choices, read from the row.
- No `format=json|csv` (export is not a shared capability).
- No mutation verbs. The public router exposes `GET` only; a test asserts the
  public paths reject `POST`/`PUT`/`DELETE`/`PATCH`.
- No `?lang=` on the API. The payload is data; every human-readable string in
  it (biomarker names, units, entry titles) is already a persisted value or
  the frontend's own copy. Localizing chrome is the frontend's job.

### 5.4 How the tenant-scoped API stays closed

The tempting shortcut is to give `GET /api/timeline` and friends an
"owner or share token" dependency. Explicitly rejected:

- It converts an auth question into a per-endpoint question. One forgotten
  guard, or one new endpoint that copies the dependency, and `/api/export`,
  `/api/entry/{id}` or `/api/extract` becomes publicly reachable.
- The shared payload is not the tenant payload: it strips attachments, drops
  an owner-facing field, applies scope, and refuses owner filters. Those
  differences belong in one place, not scattered as `if shared:` branches
  through the timeline, flowsheet and entries routers.
- The e2e golden harness and the extraction pipeline read those routers. They
  stay untouched, which is worth a lot on its own.

So the shared router imports the *builders* (`_events_from_db`,
`_build_flowsheet`, the `_serializers` helpers) and never imports the routers.

**One builder needs a small, additive signature change:**
`_events_from_db(db, patient_id, include_attachments=True)`. Its only existing
caller keeps the default. This is a refactor of an internal helper, not a
contract change.

### 5.5 Expiry and revocation on the next request

Both are evaluated inside `resolve_share_context` on every request, so
revocation is effective immediately with no grace window and no cache
invalidation. This only holds if nothing between the recipient and the
resolver is allowed to cache a response (§8.1). The public responses carry
`Cache-Control: no-store`; that header is a security control here, not a
performance preference.

---

## 6. Attachment and file serving

v1 does not share documents (D3). Technically that is three concrete rules:

1. **The public payload contains no attachment data.** `_events_from_db` runs
   with `include_attachments=False`, so no `/static/uploads/...` URL and no
   filename reaches the recipient. The recipient's browser therefore never
   requests an upload, and the existing `/static/uploads/{path}` guard in
   `backend/app/main.py` is never exercised by a share link.
2. **The existing guard stays exactly as it is.** It requires
   `get_current_user_or_anon` and an attachment row whose entry belongs to the
   resolved principal. A recipient has no session and no matching row, so a
   hand-guessed `/static/uploads/...` URL is a 403 — which is the correct
   answer for v1 and requires no change.
3. **The public record endpoint does not accept or mention a file id.**
   There is no `/api/share/file/...` route.

If attachments ever travel (§10 of the product plan, Stage 4), the change is
**not** "let the share token through the existing guard". Precisely, it would
need:

- The guard to accept a *second* authorization path that resolves a token to
  an owner id **and** checks that the requested file's entry is inside the
  link's scope and that the link's `include_attachments` is on — the file
  decision must use the same scope resolution as the record, not a bare
  ownership check.
- URLs in the payload that do not carry the share token. A token in a download
  URL lands in browser history and in the `Referer` of anything the downloaded
  PDF links out to, and a file response cannot carry `no-store` meaningfully
  for a download. The clean design is a short-lived signed file token minted
  per attachment by the record endpoint (HMAC over `attachment_id` + `exp` +
  a scope version, minutes long), so a leaked URL is worthless shortly after.
- A decision about scanned-page PII that is the product's to make, not this
  plan's: a lab scan routinely carries the owner's full name, address and
  insurance number, sometimes a family member's data.

None of that is built in v1. Leaving the guard untouched is what makes the
"attachments are excluded" statement checkable rather than aspirational.

---

## 7. Frontend shape

### 7.1 The route, and why it needs its own layout

Route: `frontend/src/app/(public)/s/[token]/page.tsx`.

Today every page sits under the single root layout
(`frontend/src/app/layout.tsx`), which mounts `AuthProvider` → NextAuth's
`SessionProvider` + `AuthInitializer` + `AuthStatusProvider`, plus
`QueryProvider`, `ThemeProvider`, `LeaveGuardProvider` and
`PrintConfigProvider`. A recipient landing on a page under that tree would:

- trigger a NextAuth session fetch (and potentially mint a session cookie),
- mount the leave-guard that watches for AI processes,
- inherit a query client that retries failed fetches.

The product requires the opposite: "opening a link must not mint an anonymous
session, set a login cookie, or record anything about the recipient" (§4.3).

Next.js only removes a parent provider by giving a subtree its own **root**
layout, which means route groups. The change:

- `frontend/src/app/(app)/…` — the existing pages move here unchanged (route
  groups do not affect URLs, and the `/api` and `/static` rewrites are
  request-path rules, untouched by the file move).
- `frontend/src/app/(public)/…` — the shared route, with a layout that renders
  `<html>`, `<body>`, the fonts and `globals.css`, and nothing else.
- The current `app/layout.tsx` becomes the `(app)` layout (it already assumes
  the authed tree), and the shared layout supplies its own `<html>`.

This is a mechanical but broad diff: every page file moves one directory. It
is the single largest structural change in the feature, and §16 R1 flags it.

### 7.2 Data path: a server component with a no-store fetch

The shared page is a **server component** that fetches the record directly,
`cache: 'no-store'`, from the backend origin. Reasons:

- First paint stops depending on client JS plus a waterfall through the Next
  proxy — the thing that actually decides whether a doctor waiting in a
  corridor scrolls or closes the tab (R6 in the product plan).
- `Accept-Language` from the incoming request is available server-side, which
  is what makes "the recipient's browser decides the language" cheap.
- No react-query, no retry storm against a public endpoint, no client-side
  token juggling.

Two consequences to state explicitly:

- **Server-side fetch bypasses the rewrite.** `next.config.mjs` rewrites apply
  to *incoming* requests, not to fetches the Next server makes. The server
  component must address the backend origin directly
  (`process.env.STATIC_PROXY_URL || 'http://localhost:8000'`) — the same value
  the rewrites use. This is a new pattern in the frontend; it is one line and
  one comment, and the frontend architecture doc should record it.
- **`cache: 'no-store'` is load-bearing.** Any future route-level cache or CDN
  in front of `/s/*` breaks revocation. A test asserts the fetch options and
  the route's dynamic behaviour, because the failure mode (a revoked link that
  keeps serving) is silent.

Interactivity stays client-side: the language switch, the expandable
biomarker rows and the lazy "All results" fetch (which calls
`/api/share/flowsheet` through the rewrite, from the browser, with the same
`X-Share-Token` header).

### 7.3 Locale resolution

Two channels, kept separate, per §8 of the product plan.

**UI chrome.** Resolution order on the shared route:

1. `?lang=xx` on the URL, when `xx` is supported.
2. The request's `Accept-Language` (the recipient's browser).
3. `NEXT_LOCALE`, if the visitor happens to have one.
4. `en`.

The sender's `default_locale` is **not** in this list on its own — it can only
influence what the sender pre-fills, and per D7 the recipient's language wins.

Implementation notes, because this is the fiddliest part of the frontend:

- `src/i18n/request.ts` reads `NEXT_LOCALE` for the whole app and cannot see a
  URL parameter, so `?lang=` cannot be handled there. The shared page resolves
  the locale itself and wraps its subtree in
  `NextIntlClientProvider locale={locale} messages={messages[locale]}`,
  overriding the tree's context for that subtree only. `messages` is already
  exported per locale from `src/i18n/messages/index.ts`.
- Layouts do not receive `searchParams`, only pages do. So `?lang=` is handled
  in the page, while `<html lang>` is set by the layout from
  `Accept-Language`. To keep the document language honest, the page renders one
  small client helper that sets `document.documentElement.lang` when the two
  disagree.
- The language switch on the shared page must not write `NEXT_LOCALE`. Writing
  it would change the *recipient's own app* language if they are also a user,
  and it is exactly the kind of recipient state §4.3 forbids. It navigates to
  `?lang=<xx>` instead. If that proves noisy, a path-scoped cookie
  (`hp_share_locale`, `Path=/s`) is the alternative; `NEXT_LOCALE` is not.
- `robots.ts` (new — the app has none) disallows `/s/`.

**Data names.** Biomarker names come from the persisted `names[lang]` on the
definition, read exactly as the print document reads them, with the existing
fallback. **The shared view must never trigger a translation run** — a public
page that fires an LLM call on open is unbounded cost behind a URL a stranger
holds. `POST /api/translate-biomarkers` is owner-only and stays that way.

**Copy.** The strings in §8 of the product plan go into new `share` (sender)
and `sharedView` (recipient) catalog files under `src/i18n/messages/`, in both
locales, with the parity test covering them. Status labels reuse the existing
`statuses.*` keys — no second vocabulary. The dead-link page's copy is part of
`sharedView`.

### 7.4 Print

The recipient's print path is the browser's own print over the shared page,
which is the same model the app already uses (`@media print` in
`globals.css`). What the shared page needs:

- The print output drops the language switch, the CTA and the orientation
  strip's interactive bits, and keeps the header (if shared), the flags block,
  the history and the full table. `globals.css` already has a print block; the
  shared surface adds its own `print:hidden` markers rather than a second
  stylesheet.
- The print editor (`/print-editor`, `/print-setup`) is not involved and is
  not reachable from the shared tree.
- "One-click PDF" remains deferred (roadmap); nothing here changes that.

### 7.5 What the route must not do

- No `AuthProvider` in its tree (that is the point of §7.1).
- No call to `/api/auth/me`, `/api/auth/session`, or any NextAuth route.
- No react-query, no toast host, no leave-guard.
- No `NEXT_LOCALE` write.
- No import of the write API module (§9.3).

---

## 8. Live-link mechanics

### 8.1 Always current

Every read is a fresh DB read. Concretely:

- Backend: the public endpoints read through the same builders the authed
  routes use, against `owner_id`, at request time. No snapshot table, no
  stored render, no `Last-Modified` short-circuit.
- Backend headers: `Cache-Control: no-store`, plus `X-Robots-Tag: noindex`.
- Frontend: `cache: 'no-store'` on the server fetch; the route is dynamic
  anyway (its layout reads request headers).
- No service worker, no stale-while-revalidate, no ISR.

The recipient sees corrections and deletions on their next load for the same
reason (§7.4 of the product plan): a deletion is just the absence of a row.

### 8.2 "Last updated", and its honest limits

`last_updated` is derived, not stored: `MAX(MedicalEntry.created_at)` over the
owner's entries within the link's scope, falling back to the link's
`created_at` when there are no entries.

The limitation, stated because the product relies on this stamp to explain a
disappearing value: `created_at` is the *upload* time, so a deletion or an
edit does **not** move the stamp. v1 ships the derived value. The cheap
upgrade (Q3) is a per-owner `record_changed_at` watermark touched by the entry
write and delete paths, which makes the stamp mean "the record changed"
instead of "something was added". A smaller nit follows from the same
derivation: the stamp is a timestamp and the page shows a date, which is what
the product's copy ("Last updated {date}") asks for.

### 8.3 The sender's new-data notice, without recipient polling

Nothing polls. The recipient's page is a static render per load; there is no
SSE, no websocket, no background refresh. The sender's notice is computed
server-side when the sender loads the timeline or the settings card:

```
active_links = links where owner_id = me, revoked_at IS NULL, expires_at > now
notice_count = |{ l in active_links : l.last_notified_entry_at IS NULL
                                     OR l.last_notified_entry_at < newest_entry_created_at }|
```

with the caveat from §8.2 that "new data" means "newly added entries". The
notice's dismissal writes `last_notified_entry_at = newest_entry_created_at`
on the owner's active links, which is why the column lives on the row instead
of in a settings table the product does not have. This is the one field the
plan adds beyond the product plan's enumerated set; §16 R6 records that it is
a design choice rather than a requirement.

The product plan's §11 metrics want more than the notice: "return visits
within 30 days" and "re-open after new data" need an aggregate read counter.
D14 permits it as long as it identifies nobody, so the minimal addition is an
opaque `open_count` integer and a `last_opened_at` timestamp on the same row —
no IP, no device, no per-visit rows. Whether to collect them is Q2 (§19);
where they are stored is Q5.

---

## 9. Component reuse, and the read-only guarantee

### 9.1 The decision

The recipient view reuses the real components and visual language — that is
the flagship's pitch — but not the authed pages, and not the authed data path.
Concretely, the shared surface renders:

- the orientation strip and the "Needs attention" flags block (purpose-built,
  flags first — this is the part the patient's timeline does not have),
- the timeline/trend components over the shared payload for "What changed" and
  the history section,
- the full table from the shared flowsheet payload,
- the disclaimer and the CTA.

Two things are not reused: the app's navigation/header chrome, and the
correlation chart (§10).

### 9.2 Expressing read-only without a second `isDemo` boolean

There is exactly one live `useDemoMode()` call site today
(`entry-settings.tsx`, hiding the delete danger zone) plus an omitted
`TimelineContent.onViewDetails` prop. That is the moment to replace the
boolean with a capability, before a third surface arrives:

```
type ViewerCapabilities = {
  canDeleteEntries: boolean      // owner only
  canNavigateToDetails: boolean  // owner; false on demo, per-data-source on shared
  canUpload: boolean             // owner only
}
```

in one provider with three values — `owner`, `demo`, `shared` — replacing
`DemoModeProvider`. Components ask for the capability they mean. The costs of
the alternatives:

- *A second boolean (`isShared`)*: every stateful component grows a second
  check and the two flags can be set inconsistently; the check is invisible in
  the component's intent. Rejected.
- *A separate read-only component tree*: guaranteed to drift from the real UI,
  and it forfeits the "a doctor sees HealthPassport working" claim. Rejected.
- *Reuse the authed pages with hidden affordances*: the shared route cannot be
  in the authed shell (§7.1), and hiding a button is not a security property.
  Rejected for the shared route. It is, however, exactly the right shape for
  the **sender preview** (§9.4), because there the viewer is the owner.

### 9.3 The guarantee that the shared route cannot write

Hiding affordances is presentation. The guarantee has four layers:

1. **Backend**: the public router is GET-only and takes no tenant id. Even a
   stray button in the shared tree would hit a 404/405.
2. **Router**: the sender endpoints live in the same file but under the owner
   dependency, on a different path prefix (`/api/share/links`), never
   reachable with only a share token.
3. **Module boundary**: the shared view must not import the write half of
   `frontend/src/services/api.ts`. A test walks the import graph under
   `src/app/(public)/` and the shared view module, and fails on an import of
   the write API or of `lib/auth-token`.
4. **Capability**: the shared tree renders inside the `shared` capability, so
   even reused components receive `canDeleteEntries: false`.

Layer 1 is the real one; 2–4 are the reasons it stays true.

### 9.4 The sender preview

Because the raw token is never recoverable (§4.2), a "preview what your doctor
will see" feature cannot fetch the share endpoint — and should not. It renders
the shared *components* over the sender's *authenticated* payload, in the
owner capability, on a route inside the app shell. Same components, different
data source, different capability. This gives the sender the disclosure story
("this is what they see") without a second public surface, and it is the
reason the shared components must take data as props rather than fetch it
themselves.

---

## 10. Excluded surfaces — unreachable, not hidden

| Surface | Why it cannot be reached from the shared route |
|---|---|
| Correlation chart | Imported only by `CorrelationView`; the shared tree does not import it, and its suggested pairs / r values are computed client-side from the tenant timeline, which the shared payload does not provide. |
| Print editor / print setup | Not imported by the shared tree. It depends on `PrintConfigProvider` state and the tenant flowsheet payload; print styling on the shared page is `@media print`. |
| Upload / add-entry | Owner-only routes; no link from the shared tree and no extract call. |
| App navigation / header | Not rendered (separate root layout). |
| Settings / shared-links card | Owner-only; no link from the shared tree. |
| Notifications bell | Owner-only endpoints (`get_current_user_or_anon_strict`). |
| Entry delete | Capability `canDeleteEntries: false` **and** no delete route on the public API. |
| Inferred-unit rings | The shared payload drops `canonical_unit_inferred`; the ring components are not imported. |
| `needs_review` warnings | Present in the payload (the table needs them) but excluded from the shared flags/trend computation, rendered in the table as the neutral "not standardised" mark per D13. |

One honest caveat: routes like `/correlation` or `/settings` remain navigable
URLs. A recipient who types one lands on the ordinary app page, which fetches
with no bearer token, resolves as an anonymous session, and shows empty data —
the pre-existing behaviour for any logged-out visitor, unchanged by this
feature. "Unreachable from the shared route" means the shared render tree
cannot navigate there and the share token cannot fetch their data. It does not
mean the app's URL space is partitioned. Worth one sentence in the frontend
doc so nobody reads the table as a stronger claim than it is.

---

## 11. Anonymous senders

- **Cap at creation, server-side.** If the resolved principal is anonymous, a
  requested expiry beyond 7 days is rejected with a localized 400 (rather than
  silently clamped — a clamp makes the app lie about what the sender chose).
  The dialog offers only 1 and 7 days for an anonymous sender; the server is
  the enforcement.
- **Nothing else changes.** Anonymous links are created, listed, revoked and
  served by exactly the same code paths as registered links; `is_anonymous`
  affects only the cap and the copy.
- **Cookie lost.** The link stays live until `expires_at` and becomes
  unrevocable by anyone. A new anonymous session cannot list or revoke it —
  the list is filtered by `owner_id == current principal`. This is R3 in the
  product plan, and it is bounded in a way worth stating: the anonymous cookie
  lives 30 days (`ANONYMOUS_COOKIE_MAX_AGE_S`) and the link lives at most 7,
  so a lost cookie can only produce an unrevocable link inside the last week
  of the session's life.
- **Registering rescues it.** The `migrate_data` re-key (§3.3) moves the links
  onto the new patient id and keeps revoke working. A sender who registers
  after sharing does not lose control.
- **The copy obligation is real.** "Clear your browser data and you will no
  longer be able to revoke this link" is the sentence that makes this design
  defensible, and it belongs next to the link at creation, not in a help page.

---

## 12. Security and abuse

**Enumeration.** 256 bits of uniform random, looked up by hash. No sequence, no
owner id component, no issued-count leak. A wrong token and a never-issued
token produce the same response.

**Dead-link uniformity.** One 404, one body, one status, for missing,
malformed, expired and revoked. The page never confirms what the link was and
says only "ask the person who shared it" (product §4.6).

**No indexing.** `app/robots.ts` disallows `/s/`; the shared page's metadata
sets `robots: { index: false, follow: false }`; the API responses carry
`X-Robots-Tag: noindex, nofollow`.

**No referrer leakage.** Page metadata sets `referrer: 'no-referrer'`; the CTA
link carries `rel="noreferrer"`; the client-side fetches pass
`referrerPolicy: 'no-referrer'`. This keeps the token out of the `Referer` of
the API call (same-origin, but still logged by the Next proxy) and out of
anything the recipient navigates to next.

**Rate limiting.** The public surface reuses the in-memory sliding-window
pattern already in `app/api/auth.py` (`_throttled` / `_throttle_windows` under
a lock), keyed per client IP: a generous read budget that stops enumeration
floods and accidental loops without touching a legitimate reader. Two
constraints stated plainly: the counter is per-process and resets on restart,
and a 429 must not distinguish one token from another. If it needs to grow
beyond that, the honest answer is a shared store — the same class of decision
as the import queue's single-process constraint (§17.1).

**What a leaked token exposes.** Exactly the shared scope, until expiry or
revocation — including to whoever the link was forwarded to, which the sender
copy says in those words (product §9). No owner email, no account identity, no
knowledge that other links exist, no way to enumerate.

**Hooks left for the abuse/takedown path** (a product/ops question, Q10, not
decidable here):

- The row carries `id`, `owner_id`, `created_at`, `expires_at` and
  `first_opened_at` — enough for ops to identify a reported link from its URL.
- The owner-only revoke endpoints do not help a third party, so a takedown
  needs an ops path. Leave a small script next to the existing
  `scripts/make_admin.py` pattern (`scripts/revoke_share_link.py`: hash the
  URL's token, set `revoked_at`) as the escape hatch, and let the abuse
  contact live in the legal/policy work rather than in this feature.
- Deliberately *not* built: an admin-visible list of links. That would put
  every user's shared clinical data one query away from an operator.

---

## 13. Testing plan

Everything below runs offline. No `MISTRAL_API_KEY`, no network, no e2e
harness, no benchmark.

### 13.1 Backend (pytest, in-memory SQLite via `tests/conftest.py`)

New `tests/test_share_links.py`:

- **Lifecycle**: create → `GET /api/share/record` returns the record → revoke →
  the same request is the uniform 404.
- **Expiry**: a link with `expires_at` in the past is the same uniform 404.
- **Uniformity**: missing token, garbage token, expired token and revoked
  token produce byte-identical status and detail.
- **Token storage**: the row's `token_hash` equals `sha256(raw)`, the raw token
  appears nowhere in the row, and the create response returns it exactly once.
- **Cross-principal isolation**: principal A's token never returns B's entries,
  readings, visits or definitions; an anonymous token never returns a
  registered principal's data, and vice versa.
- **Scope**: a range link excludes entries outside the window and the
  biomarkers derived from them; a whole-passport link has no bounds.
- **Anonymous cap**: an anonymous principal requesting 30 days gets a 400; 7
  days succeeds; a registered principal requesting 30 days succeeds.
- **First open**: the first request sets `first_opened_at`; a second request
  does not move it.
- **Ownership of the manage routes**: a second principal cannot list, revoke,
  or revoke-all another principal's links; revoke-all affects only the
  caller's own rows.
- **Account deletion** deletes the principal's links.
- **Anon → register re-key**: after `copy_anonymous_data`, the link's
  `owner_id` is the new patient id, `is_anonymous` is false, and the link
  serves the registered record.
- **Payload rules**: `events[].attachments == []` for every event;
  `canonical_unit_inferred` absent from every definition; merged readings
  absent from the shared payload; a `needs_review` reading present in the
  payload but not in the flags the product defines.
- **Verb**: `POST`/`PUT`/`PATCH`/`DELETE` on the public paths are rejected.
- **Localization**: the dead-link detail and the anonymous-cap detail resolve
  through `share.*` keys in both locales (extend `tests/test_i18n.py`).

New `tests/test_share_public_route.py`:

- A public request sets no `Set-Cookie`, creates no `UsageLimit` row, and bumps
  no `last_activity`.

### 13.2 Frontend (vitest, jsdom, `TestI18nProvider`)

- The shared view renders the orientation strip, flags, history and table from
  a mocked payload; the dead-link state renders for a 404; a network error
  renders the error state, not a blank page.
- `?lang=ru` renders RU chrome; with no `NEXT_LOCALE` cookie and an
  `accept-language: ru` header the resolved locale is `ru`; the shared page
  never writes `NEXT_LOCALE`.
- Read-only: no delete, upload, print-editor, settings or notification
  affordances are rendered; the import-graph test from §9.3 passes.
- Flags-first: an out-of-range reading appears in the flags block; a
  `needs_review` reading does not, and appears in the table with the neutral
  mark.
- `sharedView` / `share` catalog parity is covered by the existing
  `messages.test.ts` (en/ru key parity, no empty values).

### 13.3 Local verification at zero API cost

Backend on a **non-8000** port against the local dev DB, `pnpm dev` for the
frontend, a link created through the UI, opened in a private window, revoked,
opened again. The e2e golden harness and the benchmark are explicitly **not**
run: the extraction pipeline is not touched, and both spend real credits.

### 13.4 Off limits

`backend/e2e/**`, `backend/app/services/extract_jobs.py`,
`backend/tests/conftest.py`, `backend/tests/test_extract_jobs.py`, the
extraction pipeline, and the benchmark corpus.

---

## 14. Doc-sync obligations

Ship these in the same change. Each line is a documented statement that stops
being true.

**`backend/docs/architecture.md`**

- *Anonymous session principal (auth)*: add that a share token is a third
  principal class — not a session, no cookie, no `UsageLimit` — and the only
  place a request-supplied string resolves to a tenant id.
- *DB migrations*: note the new `share_links` table (created by `create_all`;
  columns later via `migrate_add_columns`).
- *Response localization*: the new `share.*` catalog keys, and the rule that
  the public payload carries no server-localized strings.
- *Auth & password reset*: the `DELETE /api/auth/account` cascade now includes
  the principal's share links.
- A new **Public share surface** section: token-hash storage, transport, the
  single resolver, uniform dead link, `no-store`, GET-only, no session
  minting.
- The anon→register migration (`copy_anonymous_data`): the re-key.

**`frontend/docs/architecture.md`**

- *API proxying*: the shared route's server-side fetch addresses
  `STATIC_PROXY_URL` directly (rewrites do not apply to server-issued fetches).
- *UI localization*: the shared route's locale resolution (`?lang=` →
  `Accept-Language` → `NEXT_LOCALE` → `en`) and the rule that it never writes
  `NEXT_LOCALE`.
- A new **Shared view (`/s/<token>`)** section: the route groups, the absent
  `AuthProvider` (and why), the read-only capability provider replacing
  `DemoModeProvider`, `no-store`, `no-referrer`, `noindex`, `robots.ts`, print
  behaviour.
- *Demo surface*: `DemoModeProvider` is replaced by the capability provider;
  the paragraph that names `useDemoMode()` becomes false.

**`AGENTS.md`**

- Backend invariants: a new "public share surface" invariant (hash-only token,
  one resolver, GET-only, no session minting, `no-store`, uniform dead link).
- Frontend invariants: the shared route is outside `AuthProvider`, never writes
  `NEXT_LOCALE`, and renders in the read-only capability.

Roadmap: §1.1's "Technical shape" bullet about the `/static/uploads` guard is
superseded for v1 (attachments excluded); the guard change moves to the
deferred candidate.

---

## 15. Build order

Mapped onto the product plan's Stage 1–3. Each step is independently reviewable
and deployable.

**Stage 1 — the loop's minimum (whole passport, fixed 7 days, header on, notes
off, no attachments).**

1. `ShareLink` model + `share_links` table; `services/share_links.py` with
   `create_link`, `resolve_share_context`, `revoke_link`, `list_owner_links`;
   the `_events_from_db(include_attachments=…)` signature.
2. `backend/app/api/share.py`: the two public GETs and the four owner routes,
   fixed configuration in this stage; `share.*` i18n keys; the backend test
   files.
3. The route-group split and the `(public)` layout; `/s/[token]` server
   component with the no-store fetch and locale resolution; the
   `SharedRecordView` (orientation strip, flags, trends, history, full table,
   disclaimer, CTA); `robots.ts`; metadata (`noindex`, `no-referrer`); print
   markers; the `sharedView` catalog; frontend tests.
4. The sender entry point next to print/export, the create dialog with the
   fixed configuration, and revoke from the same place; the read-only
   capability provider (replacing `DemoModeProvider`).
5. Doc sync for everything above.

After Stage 1 the product's proof exists end to end: a doctor opens a live
record, the sender takes it back, and neither the extraction pipeline nor the
e2e harness has moved.

**Stage 2 — control and awareness.**

6. The expiry choice (1/7/30) and the anonymous 7-day cap + warning; the scope
   choice (whole passport / from a date); the header and notes toggles in the
   dialog and honored by the resolver.
7. The full "Shared links" card on `/settings`: all three states, revoke,
   revoke-all, `first_opened_at` display.
8. The new-data notice and its `last_notified_entry_at` watermark.
9. `open_count` / `last_opened_at` (if Q2 says yes) and the sender-side metric
   events, with `ImportFunnelEvent`-style rows as the storage.
10. Doc sync.

**Stage 3 — reach and polish.**

11. The recipient language switch and `?lang=`; the sender's optional link
    default locale.
12. The mobile pass on the shared view (the flowsheet matrix degrading to
    per-biomarker cards).
13. Print styling polish for a printed shared view.
14. The sender's preview (over the authenticated payload, owner capability).
15. CTA instrumentation; doc sync.

**Stage 4 — deferred, on evidence.** Passcode-protected links, attachments
with short-lived file tokens, snapshot links, per-entry-type exclusions. Each
changes the slug of this plan (a passcode adds a verification step before the
resolver; attachments add the file-token mint), and none should be built
before Stage 1–3 data says which one matters.

---

## 16. Risks and unknowns

- **R1 — the route-group refactor is the biggest diff.** Moving every page into
  `(app)` is mechanical but touches dozens of files, and the working tree has
  another thread in it. If the move is too disruptive to land at once, the
  fallback is an `AuthProvider` that mounts nothing when a `public` flag is
  set — uglier, and it keeps the next-auth machinery in the tree.
  *Recommendation:* do the route groups in their own commit, before any share
  code, so the refactor's diff is reviewable on its own.
- **R2 — hash-only tokens mean no re-copy.** Expected consequence, not a defect
  (§4.2). If support shows otherwise, the fix is an encrypted copy, not a
  plaintext one.
- **R3 — "Last updated" ignores edits and deletions.** §8.2; add the
  `record_changed_at` watermark if recipient interviews say the stamp mattered.
- **R4 — any caching layer silently breaks revocation.** The failure is
  invisible in dev and dangerous in production. Mitigate with `no-store` on
  both sides plus a test that asserts the fetch options, and name it in the
  frontend doc.
- **R5 — in-memory rate limiting is per-process.** Adequate under the
  single-process constraint, wrong the moment the deployment scales — the same
  shape as the import queue's constraint.
- **R6 — the new-data watermark is an invention.** `last_notified_entry_at` is
  the cheapest way to make product §5.5 work without a settings table; a
  different owner-visible mechanism (a bell notification) would reuse
  `Notification` instead. *Recommendation:* keep the column; revisit if the
  notice becomes a real notification.
- **R7 — the shared page must not mint state, and the natural implementation
  does.** Putting `/s/[token]` under the existing root layout would mount
  NextAuth and the anonymous cookie path. §13's no-session tests are the guard.
- **R8 — data language is persisted, chrome language is not.** A German
  recipient of a never-translated record sees English biomarker names, and the
  shared view must not translate on open. This is a real gap for the traveler
  persona (Q6 in the product plan), and the technical answer is "the sender
  translates during sharing, at their cost", which is Stage 3+ work.
- **R9 — no single-process conflict, but one write-on-GET.** §17.1.
- **R10 — legal and abuse posture are not technical.** §12 leaves the hooks (an
  ops revoke script; a row rich enough to identify a reported link) and nothing
  more; Q10/Q11 in the product plan still need an owner decision before public
  launch.

---

## 17. Direct answers

### 17.1 Does this conflict with the single-backend-process-per-DB constraint?

No. The feature adds no worker, no queue and no background job:

- No GC, because expired links are history (§3.3).
- No notifications in v1; the new-data notice is computed during a sender's own
  read.
- The first-open write is a single conditional `UPDATE` from the request path,
  which the existing WAL + `busy_timeout` configuration handles next to request
  traffic.
- `assert_single_process`, `recover_orphan_jobs` and the whole import-job
  machinery are untouched.

The one thing that *would* introduce a background dependency is emailing the
sender when a link is opened — a deferred idea, and if it is ever built it
should go through the existing in-request `BackgroundTasks` + `mailer.deliver`
path that auth already uses, so it stays single-process clean.

### 17.2 Does the anonymous cookie interact with the public route?

It must not, and that is an implementation requirement rather than a happy
accident:

- The public endpoints depend on `resolve_share_context`, **not**
  `get_current_user_or_anon`, because the latter calls `get_or_create_anon_id`
  and sets a cookie as a side effect. A share link opened by a stranger must
  not mint a session.
- The public frontend route is outside `AuthProvider` for the same reason
  (§7.1): `SessionProvider` would fetch `/api/auth/session`.
- A recipient who *is* a logged-in user is still treated as a stranger: the
  share token is the only credential the shared page uses, and their bearer
  token is neither read nor needed.
- The sender's own endpoints keep using `get_current_user_or_anon` (and the
  `_strict` variant where the existing pattern uses it) unchanged.
- The one place the cookie and sharing meet is the anon→register re-key
  (§3.3), which reads the same verified anon id the register path already
  reads.

### 17.3 Does `LocaleMiddleware` cover the new public routes, and should it?

Yes, and yes. `LocaleMiddleware` is mounted app-wide as pure ASGI
(`app.add_middleware(LocaleMiddleware)` in `app/main.py`), so it resolves
`Accept-Language` for `/api/share/*` with no change. It should stay: the public
surface still returns localized `detail` strings — the uniform dead link, the
anonymous-cap 400, malformed-request errors — and those must respect the
recipient's language like every other user-facing string in the backend.

It does **not** localize the shared view. The record payload is data, and the
chrome is localized by the frontend from its own resolution (§7.3). That split
— the middleware for API text, the frontend catalogs for rendered UI — is the
repo's existing split, and inventing a third localization path for the shared
payload would be worse than reusing both as they are.

---

## 18. Where the product plan forces a worse technical shape

Three, all consequences rather than mistakes.

1. **"Whole passport by default" plus "the sender may share before results are
   in" (D1, §7.3) means the shared payload's composition changes under the
   recipient.** That is the feature, so nothing here resists it — but it rules
   out any response-level caching, ETags, or CDN assistance for the public
   surface, permanently. The recipient view is a dynamic page with a `no-store`
   read on every open, and its first-paint budget has to be paid in query
   efficiency and payload shape rather than in HTTP caching. The mitigation is
   the two-call split (§5.2): timeline-shaped record first, flowsheet only when
   the full table is opened.

2. **Hash-only tokens make the sender's list read-only in the strongest sense:
   it cannot re-display a link.** The product plan's §5.4 list and §5.5 "what
   is out there" work fine with that. What does not survive is any future ask
   of the shape "show me my link again" or "resend the same link" — those
   become "create a new link", with a new expiry. If the owner wants re-copy,
   the shape to ask for is an encrypted-at-rest copy, not a plaintext column.

3. **D13 ("`needs_review` readings excluded from flags, shown in the table with
   a neutral mark") requires the reliability flag to cross the wire to a
   stranger.** That is fine and it is what makes the table honest, but it means
   the shared payload cannot be a minimal, curated shape — it is the real
   reading shape with one owner-facing field removed. Anyone tempted later to
   trim the shared payload further should check D13 first, because the neutral
   mark depends on that field being there.

---

## 19. Open questions for the owner

The `Q…` ids below are **local to this document** — the product plan
(`docs/phase-1.1-product-plan.md` §12) numbers its own questions
independently, so "Q2" here is not "Q2" there. Cite the document when quoting
an id.

| # | Question | Recommendation |
|---|---|---|
| **Q1** | Re-copy a link from the list, or hash-only? | **Hash-only** for v1 (§4.2). Revisit with an encrypted copy if support shows real loss. |
| **Q2** | Do the §11 metrics need an opaque `open_count` / `last_opened_at` on the link row? | **Yes** — they are the only way "return visits" and "re-open after new data" exist, and they identify nobody (D14 permits a count). |
| **Q3** | Is `last_updated` = `MAX(entry.created_at)` good enough, given deletions do not move it? | **Ship it**, and add the `record_changed_at` watermark in Stage 2 if the stamp is load-bearing for recipients (§8.2). |
| **Q4** | Is the sender-side preview in v1 or Stage 3? | **Stage 3** — real value for the disclosure story, not needed for the loop. |
| **Q5** | Where do the share metrics live? | Pick the home **before Stage 2**, reusing the existing write-only funnel-event pattern; no recipient identity. |
| **Q6** | Does the sender get a "translate for this recipient" step, given the shared view must not translate on open? | **Defer to Stage 3**, and only if traveler usage shows up — but state the cost when it lands (a translation run at share time, on the sender's quota). |
| **Q7** | Should an anonymous sender see the 30-day option greyed out, or only 1/7? | **Only 1 and 7**, with the cookie warning. A greyed-out option invites a support question with no answer. |
| **Q8** | Does `?lang=` or a path-scoped cookie drive the shared view's language switch? | **`?lang=`** first (§7.3): stateless, shareable, and unable to leak into the recipient's own app locale. |
| **Q9** | Route-group refactor now, or an opt-out `AuthProvider`? | **Route groups**, in their own commit (R1). |
| **Q10** | Where is the takedown/abuse path? | Not answerable here; the technical hooks are §12, and the process is a pre-launch requirement. |
