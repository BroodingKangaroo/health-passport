# Phase 1.1 — Stage 2 plan: sender control and awareness

**Status:** decided — the owner delegated the Stage 2 questions to the
recommendations in `docs/phase-1.1-product-plan.md` §12 and
`docs/phase-1.1-technical-plan.md` §19, and this document adopts them. Where
this plan answers a question, that answer supersedes the open question.
**Date:** 2026-09-16.
**Source:** `docs/phase-1.1-product-plan.md` §13 (Stage 2 — control and
awareness), `docs/phase-1.1-technical-plan.md` §15 (build order), and the
Stage 1 review findings.
**Scope:** Stage 2 only. Stage 3 (recipient language switch, mobile pass,
sender preview, translate-for-recipient) and the deferred candidates are not
in this plan.

Stage 1 shipped a link with a fixed configuration. Stage 2 makes it a link the
sender controls, sees, and can take back: choose the scope and the expiry, list
every link with its state, revoke one or all, learn when new data has become
visible through an open link, and give the product a way to know whether any of
it works.

---

## 1. The eight decisions

Each was an open question; this is the answer Stage 2 implements.

| # | Question | Decision | What it forces |
|---|---|---|---|
| **S1** | Where share metrics live | A new **write-only funnel table**, `share_funnel_events` (`event`, `is_anonymous`, `created_at`), mirroring `ImportFunnelEvent`. Events are **sender actions only**: `link_created`, `link_revoked`. | One row per sender action, never deleted. No recipient identity anywhere in it. |
| **S2** | Open counters | `open_count`, `first_opened_at`, `last_opened_at` on the link row. | The list can say "opened 3 times, last 12 Sep"; "return visits" becomes `open_count > 1`. |
| **S3** | Entry free-text `notes` | **Entry notes never travel.** The toggle is dropped. | `include_notes` leaves the API surface (schema and summary). The DB column stays, unused — this repo can only *add* columns, so dropping it would need a migration path we do not have. Copy loses the toggle. |
| **S4** | Anonymous expiry options | Registered senders choose **1 / 7 / 30 days**; anonymous senders **1 or 7 only**, enforced server-side with a localized 400, not just hidden in the UI. | The create endpoint validates the requested expiry against the principal. The cookie warning is stated at creation. |
| **S5** | Date-range semantics | `{"kind":"range","from":<date>,"to":<date>}` at whole-day granularity, either end optional. Filtering happens in the **builders**, so flags, trends, visits, instrumental data, the full table and the flowsheet columns all follow the same window. | `meta.scope` reports the real scope. Every section is tested for the window, not just the record. |
| **S6** | Header toggle default | **On**, exposed as a checkbox in the dialog. | Already the shipped behaviour; Stage 2 adds the control. |
| **S7** | Abuse / takedown path | An **ops revoke script** (`backend/scripts/revoke_share_link.py`): takes a raw token from a report, hashes it, revokes the row, logs the action. Plus the process written into the backend doc. | Deliberately no admin-visible link list — the script addresses one reported link and nothing else. |
| **S8** | Legal posture | Keep the **consumer framing** ("the owner shares their own record"). The Stage 2 disclosure copy is written to match, and the pre-launch legal review stays a checklist item, not code. | Copy review is part of the change. |

Already settled by Stage 1 and unchanged here: account deletion kills every
link while anonymous session loss leaves links live but unrevocable; no cap on
active links; hash-only tokens, so the list presents "create a new link" as the
recovery path rather than "resend".

### The record watermark

S2 and the new-data notice (S9 below) both compare "the newest data the owner
had at moment X", computed as `MAX(entries.created_at)` for the owner.

- The **notice** needs a per-link watermark the sender has acknowledged:
  `notified_record_at`, initialised at creation, bumped when the sender
  acknowledges the notice.
- The **return-after-new-data metric** needs what the recipient saw: the
  watermark observed at the first and the most recent open
  (`first_open_record_at`, `last_open_record_at`), so "came back after new
  data" is `open_count > 1 AND last_open_record_at > first_open_record_at`.

One limitation to accept and document: this watermark is derived from entry
`created_at`, so **deleting an entry does not move it**. A dedicated
`record_changed_at` column is deferred until a stamp proves load-bearing.

---

## 2. What ships

**Sender — the "Shared links" card** (`/settings`, beside the export and danger
zone cards): every link the sender ever created, newest first, each in one of
three states computed **server-side** (active / expired / revoked), showing its
scope in words, its expiry, whether it has been opened and when, and a Revoke
button. The card carries **Revoke all links**.

**Sender — the create dialog**: scope (everything, or from/to dates), an expiry
choice, and the header checkbox. Anonymous senders get only 1 and 7 days plus
the cookie warning. The notes toggle is gone.

**Sender — the new-data notice**: a quiet inline line on the timeline when new
data exists and at least one active link could see it — "N active links can see
your new results" — with the acknowledgement that clears it and a link to the
card. It must not become a nag: it appears only while true, and acknowledging
it settles every listed link.

**Sender — the ops revoke script** (S7).

**Recipient** — unchanged except that the record respects the link's scope.
No capability-provider work: the shared tree still reuses only components
without affordances.

**Not in Stage 2**: attachments, recipient chrome languages, the sender
preview, translate-for-recipient, snapshot/freeze links, per-entry sharing, the
capability provider.

---

## 3. Contracts

- `POST /api/share/links` takes a body: `expiry_days` (validated against the
  principal, S4), `scope` (null or a range, S5), `include_header` (S6). It
  returns the raw token once, as today.
- `GET /api/share/links` returns each link's computed state, its scope, its
  expiry, its opened state (S2) and whether it is behind the current record
  watermark. The client renders states; it never derives them.
- The public read path is unchanged: same resolver, same single enforcement
  point, same uniform 404, same `no-store`. Scope narrows what the builders
  return; it never widens what a token can reach.
- `include_notes` disappears from `ShareLinkSummary` and the schemas.

---

## 4. Copy

New EN/RU keys for the card (title, empty state, the three state labels, scope
in words, opened / not opened, revoke, revoke all, the confirmation), the dialog
(scope, expiry, header checkbox, the anonymous warning), and the new-data
notice. Deleted keys: the notes toggle, and the two dead sender strings removed
in the review round are already gone. Existing EN strings are pinned by tests —
add, do not reword.

---

## 5. Testing

**Backend**: expiry validation per principal incl. the anonymous 400 and a
localized detail; scope filtering asserted on *every* section (flags, trends,
visits, instrumental, full table, flowsheet columns) and on `meta.scope`;
counters (first open, repeat open, the debounce that stops a refresh inflating
the count); the notice lifecycle (false at creation, true after a new entry,
false after acknowledgement); revoke-all; the funnel rows written exactly once
per action; the ops script revoking by token and failing cleanly on an unknown
one; and that `include_notes` is gone from the wire.

**Frontend**: the card's three states, the empty state, revoke-all, the dialog
variants (registered vs anonymous), the notice, and the absence of a notes
toggle.

---

## 6. Doc sync

In the same change:

- `AGENTS.md` — the public-share bullet: scope now exists, the create endpoint
  takes a validated expiry, open counters exist, and entry notes never travel.
- `backend/docs/architecture.md` → "Public share surface" — scope semantics,
  the expiry rule and its cap, the counters and the watermark, the funnel
  table, the ops script.
- `frontend/docs/architecture.md` — the settings card and the dialog.
- `docs/phase-1.1-product-plan.md` — D4 and the copy table (notes no longer
  travel) and §13's Stage 2 wording where it is now answered.
- **Housekeeping**: both open-question tables number themselves independently
  (the product plan's Q2 is not the technical plan's Q2). Add a one-line note
  to each table saying the IDs are local to that document.

---

## 7. Risks

- **Scope filtering that misses a section** is the likeliest defect in this
  stage: six surfaces read the same data and a range only has to be forgotten
  once to leak a reading the sender excluded. Test each surface by name.
- **Counting opens is a write on a public endpoint.** Keep it one conditional
  UPDATE, debounced, and never a per-visit row.
- **The notice becomes a nag** if it does not acknowledge cleanly.
- **The UI and the server cap must agree** on anonymous expiry, or the sender
  meets a 400 the dialog never implied.
- **`include_notes` becomes a dead column.** Say so in the architecture doc
  rather than leaving the next reader to guess.
