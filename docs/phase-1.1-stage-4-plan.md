# Phase 1.1 — Stage 4 plan: safer sharing

**Status:** decided — but the choice of subject is a judgement call, not an
evidence call. See §1.
**Date:** 2026-09-17.
**Source:** `docs/phase-1.1-product-plan.md` §10 (deferred candidates) and §13
(Stage 4), `docs/phase-1.1-technical-plan.md` §15, `docs/phase-1.1-stage-3-plan.md`
(S9's deferred 7-language chrome).
**Scope:** Stage 4 only.

---

## 1. The roadmap's Stage 4 is evidence-gated, and there is no evidence

The roadmap says the deferred candidates "each get their own decision when
Stage 1–3 data says which one matters", and my own earlier recommendations
gated each one the same way: attachments "revisit with the first recipient
interviews", passcode links "once there is evidence of forwarded-link harm",
7-language chrome "no recipient has opened a link yet, so we cannot tell
whether the second language anyone needs is German or nothing".

That gate has not been met. Stage 1–3 shipped within days of this plan and the
dev database has zero share links, so nothing has been created, opened or
revoked by a real person. Any of the four candidates chosen now is chosen on
taste.

So Stage 4 does two things instead of pretending otherwise:

1. **Builds the two items that do not need demand evidence because they reduce
   harm that exists whether or not anyone wants them**: a forwarded link that
   anyone can open, and a record that carries a category the sender never
   thought about. These are safety features; demand is not the question.
2. **Builds the missing reader for the metrics** that Stage 2 and Stage 3
   deliberately made write-only. Every Stage 5 decision is currently
   unanswerable, and the cheapest way to make the roadmap's own gate real is to
   be able to read the counters.

Everything demand-shaped — attachments, 7-language chrome, snapshot links,
per-entry and per-biomarker sharing — stays deferred, with the reason recorded
in §5.

---

## 2. Decisions

### S15 — Passcode protection is opt-in, hashed, and throttled per link

The sender may set a passcode when creating a link. It is stored only as a
bcrypt hash (`auth.hash_password`, the same primitive as account passwords —
the input is a short human-typed secret, so a slow KDF is the point, not a cost
to avoid). Minimum length 6. The passcode is never returned, never logged, and
never placed in a URL.

Unlocking is a public, rate-limited `POST /api/share/unlock` that takes the raw
token and the code and returns a short-lived **grant** — an HMAC-SHA256 over
the link id, an expiry and a fingerprint of the passcode hash, signed with the
app's `SECRET_KEY`. The fingerprint is what makes a future passcode change
invalidate every outstanding grant without storing anything.

Two consequences to accept and document:

- **A passcode-protected link cannot be server-rendered on the first request**,
  because the first request has no passcode. The server renders the prompt; the
  recipient unlocks; the record is then fetched client-side with the token and
  the grant. Unprotected links keep the server-rendered first paint that Stage
  1 built. This is the price of the feature, paid only by links that opt in.
- **The grant lives in the browser, not in a cookie.** The share surface has no
  cookie by contract; the grant goes in an `X-Share-Grant` header and is held
  in `sessionStorage`, so closing the tab forgets it.

The passcode is not a security boundary against someone the sender already gave
the code to, and the create copy must say so in plain words: it protects a link
that has been forwarded, not one that has been shared with a friend.

### S16 — Per-entry-type exclusions ride the existing scope

The scope JSON gains an optional exclusion list, valid on both kinds:
`{"kind":"all","exclude":["instrumental_test"]}`. It is enforced in the same
central place as the date range, so no section can forget it — the Stage 2
review's one real risk was a filter that misses a section, and this must not
repeat it.

The types are the four that exist: `blood_test`, `doctor_visit`,
`instrumental_test`, `procedure`. Excluding `blood_test` empties the biomarker
lists, the trends and the flowsheet, so the dialog must warn before it happens
rather than leave the sender to discover it on the recipient's screen.

This is deliberately coarser than the per-entry and per-biomarker sharing the
roadmap defers: it answers "do not send my imaging" in one click, without
turning sharing into a curation task.

### S17 — The metrics get a reader, and it is an ops script

`backend/scripts/share_metrics.py` prints what the funnel table and the link
rows already hold: links created and revoked (split by anonymous/registered),
links opened at least once, repeat opens, grants issued, CTA clicks, and the
derived rates the product plan names (open rate, revoke rate, the loop). No
public surface, no new table, no recipient identity — same shape and posture as
`revoke_share_link.py`.

This is tooling, not a feature. It exists so that Stage 5 can be decided on
counts instead of taste, which is the roadmap's own rule.

### S18 — What stays deferred, and why

- **Attachments in the shared payload.** Still the decision most likely to
  reverse for the right reason (a doctor wanting the original report), and
  still the highest-PII surface. It needs the signed per-file token design from
  the technical plan and at least one recipient interview. Neither exists.
- **7-language chrome.** The largest gap between the shared view and the PDF it
  replaces, and still the wrong thing to build blind: Hebrew drags in an RTL
  layout project the shared surface has never done, and no one has yet needed a
  third language.
- **Snapshot links.** They contradict the feature's own promise; build only if
  the live behaviour confuses senders in practice.
- **Per-entry / per-biomarker sharing.** High complexity, and S16 covers the
  real use case coarsely.
- **Recipient-side read analytics.** Rejected, not deferred.

---

## 3. What ships

**4.1 Passcode protection.** A passcode field in the create dialog (optional,
with the "this protects a forwarded link, not a friend" copy); `passcode_hash`
on the link row; the public unlock endpoint with per-link throttling and one
uniform failure; the grant check on the two public reads; the recipient's
prompt-unlock-then-fetch flow; and the card showing which links are protected.

**4.2 Type exclusions.** Checkboxes for the four entry types in the dialog, the
`exclude` list in the scope, central enforcement in the builders, the
empties-a-section warning, the scope shown in words on the card, and
`meta.scope` reporting it.

**4.3 The metrics script.**

---

## 4. Contracts

- `POST /api/share/links` gains `passcode` (optional, ≥6 chars) and
  `exclude` (optional, subset of the four types). Both are validated with a
  localized 400; the passcode is never echoed and never stored raw.
- `POST /api/share/unlock` — public, rate-limited, takes the token and the
  code, returns a grant and its expiry. One uniform localized 400 covers a
  wrong code, a link with no passcode, an unknown token, and a body that omits
  or nulls either key (both default to `""`, so they take the refusal instead
  of a 422 that would echo the token back — Stage 4 review, F4). A body that
  is not valid JSON is refused by request validation before the handler runs.
- The public reads accept an optional `X-Share-Grant`; a link with a passcode
  rejects a read without a valid grant in the same uniform 404 the surface
  already uses, so an unauthenticated probe cannot tell a protected link from a
  dead one.
- `meta.scope` reports the exclusions; the authed routes still pass none.

---

## 5. Copy

New EN/RU keys: the dialog's passcode field, its warning line, the exclusion
checkboxes and the empties-a-section warning; the recipient's prompt, its
failure line and its rate-limit line; the card's "protected" marker and its
scope-in-words extension. Existing EN strings must not be reworded.

---

## 6. Testing

**Backend**: passcode hashing and verification; the minimum length and the
localized 400s; unlock success, wrong code, no passcode on the link, throttling
per link, and the uniform failure; grant validity, expiry, the fingerprint
change invalidating old grants, and the grant never being accepted without a
live link; exclusions enforced on every section (events, biomarkers, visits,
instrumental, flowsheet) and reported in `meta.scope`; and that unprotected
links and unexcluded scopes behave exactly as before.

**Frontend**: the dialog's passcode and exclusion controls; the warning when an
exclusion empties a section; the recipient's prompt → unlock → record flow with
the grant in `sessionStorage` and never in a cookie or a URL; the card markers;
and that unprotected links still server-render.

---

## 7. Doc sync

- `AGENTS.md` — the public-share bullet: the passcode, the grant, the unlock
  endpoint, the exclusions in the scope, and the fact that a protected link is
  client-rendered on first load while an unprotected one is not.
- `frontend/docs/architecture.md` — the shared view's two first-paint paths and
  the grant's storage.
- `backend/docs/architecture.md` — the scope's exclusion list, the unlock
  endpoint and the grant, the metrics script.
- `docs/phase-1.1-product-plan.md` §13 — Stage 4 as delivered, with the
  recorded deferrals and the reason Stage 4 was chosen by judgement.

---

## 8. Risks

- **A short passcode is the weak link, not the token.** Six characters with
  per-link throttling is the floor; the plan must not quietly accept four.
- **Throttling must not become an oracle**: wrong code and missing passcode
  must be indistinguishable, and the throttle must not reveal that a link
  exists.
- **The grant is a bearer credential.** It must expire, must die with the link,
  and must never be logged.
- **Exclusions are the third filter on the same builders.** The Stage 2 lesson
  stands: a filter that misses one section leaks exactly what the sender
  switched off. Test each section by name.
- **Two first-paint paths** (server-rendered when unprotected, client-rendered
  when protected) is a maintenance cost that will be forgotten. It must be
  written down in both the invariant and the frontend doc.
