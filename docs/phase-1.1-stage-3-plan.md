# Phase 1.1 — Stage 3 plan: reach and polish

**Status:** decided — recommendations adopted, with one decision flagged for
the owner in §2.
**Date:** 2026-09-16.
**Source:** `docs/phase-1.1-product-plan.md` §13 (Stage 3 — reach and polish),
`docs/phase-1.1-technical-plan.md` §15, and the Stage 2 review findings.
**Scope:** Stage 3 only. Stage 4 (passcode links, snapshot links, per-entry
exclusions, attachments, 7-language chrome) stays deferred.

Stage 1 shipped a link. Stage 2 gave the sender control of it. Stage 3 is about
the two audiences the feature exists for: the recipient who cannot read the
page comfortably, and the loop that turns a recipient into a user.

Four slices, each shippable on its own: the language switch (3.1), the reading
surface — phone and paper (3.2), the loop and its cost (3.3), and two carried
polish items (3.4).

---

## 1. What Stage 3 is not

Not in this stage, deliberately: 7-language chrome (see §2), passcode-protected
links, snapshot links, per-entry-type exclusions, attachments in the shared
payload, the read-only capability provider (still unnecessary — the shared tree
reuses no stateful component), and per-link CTA attribution (see §3.3).

---

## 2. Decisions

### S9 — Recipient language: the switch ships with EN and RU; 7-language chrome is deferred

The shared view resolves locale through `shared-locale.ts`, whose supported set
is the app's `AppLocale` (`en` | `ru`). Stage 3 adds the visible switch and the
sender's per-link default over that same set.

**Deferring the other five document languages is a real product loss, not a
technicality**, and the reason is worth stating plainly: persona 3 exists
because a Russian speaker abroad hands a record to a doctor who does not read
their language. Today that doctor sees English chrome, because `de`/`fr`/`es`/
`pl`/`he` are not in the supported set and the resolver falls through to `en`.
English is a workable lingua franca for a clinician, so this is acceptable for
v1 — but it means the shared view delivers less than the 7-language printed
passport it replaces.

The reason to defer rather than do it now: no recipient has opened a link yet,
so we cannot tell whether the second language anyone needs is German or
nothing; and Hebrew brings RTL layout work (`dir="rtl"`) that the shared
surface has never had to do, which is not a copy task. When it lands it reuses
the printed passport's existing headings verbatim and adds the remaining
strings; the locale type for the shared surface becomes its own set, separate
from the app's `AppLocale`.

### S10 — The link's default language outranks the browser's

Resolution order becomes: **`?lang=` → the link's `default_locale` →
`Accept-Language` → `NEXT_LOCALE` → `en`**.

This puts the sender's per-link choice ahead of the recipient's browser, which
looks like it contradicts D7's "the recipient's own language, never the
sender's". It does not: D7's rule is about the *sender's own UI language*
leaking into the recipient's view, and that stays forbidden. `default_locale`
is a different thing — a deliberate choice about who is receiving this link,
made by the person who knows. It is always overridable in the page, and the
dialog copy says so.

**This is the one decision in Stage 3 worth the owner's eye.** The alternative
(browser language first, the link default only as a last resort) is defensible
and would make the preset nearly inert, because browsers almost always send
`Accept-Language`.

### S11 — The phone layout is the shared component's problem, not a fork

The full table (`FlowsheetMatrix`) becomes card-per-biomarker below the
breakpoint, inside the shared component, so the owner's flowsheet and the
`/demo` surface improve with it. A second, shared-only table would drift from
the real one and forfeit the "a doctor sees the product working" claim.

The boundary: if the responsive change destabilizes the owner's flowsheet tests
or layout beyond a contained fix, fall back to a shared-view-only card variant
and record why. Prefer the shared fix.

### S12 — The printed shared view is the record, nothing else

Printing a shared page drops the language switch, the CTA and all app chrome,
and prints the **full table as a table** regardless of the screen breakpoint —
paper is wide, and a doctor printing the page wants the sheet the product is
replacing. The orientation line, the flags, the trends, the history and the
disclaimer all print.

### S13 — The CTA is measured by a tokenless redirect, and nothing else is

"Make your own HealthPassport" points at a public `GET /api/share/cta` that
increments a counter and 302s to the landing page. No per-link attribution and
no recipient identity: attribution would require the raw token in a URL, which
the public surface forbids everywhere else. The loop is measured as clicks ÷
links opened, which is what the roadmap's "subtle CTA" question actually asks.

The counter row goes into `share_funnel_events` with the sender-flag column
NULL, and the column becomes nullable: `is_anonymous = NULL` means "a
recipient-side counter", which is the one fact that keeps the table honest now
that it holds two kinds of row. The endpoint is rate-limited like the rest of
the public surface.

### S14 — "Translate for this recipient" is a registered-sender feature

In the create dialog, when the chosen link language has no persisted names for
the record's biomarkers, the sender may translate now. It reuses the existing
`POST /api/translate-biomarkers` with `persist: true`. The endpoint does not
refuse anonymous callers — an anonymous `persist: true` returns 200 and
silently skips the persistence (the 403 lives on
`POST /api/translate-biomarkers/commit`) — so the dialog hides the option for
anonymous senders, and the endpoint still enforces the privacy rule by never
writing `names[lang]` for them.

The copy must state the cost before the sender commits: this spends one AI
translation on their quota and takes as long as a print-document translation.
Declining is always allowed — the link works, the recipient sees the fallback
names.

---

## 3. What ships

### 3.1 Language

A language switch on the shared view (EN | RU) that navigates with `?lang=` —
no cookie is written, ever, and the recipient's own app locale is untouched. A
language control in the create dialog that sets the link's `default_locale`,
wired through the create request, the row (already present, always null today)
and `meta.default_locale` (already returned). `resolveSharedLocale` gains the
link-default step, and the page passes the link's stored locale into it.

The switch must survive the no-JS case as a plain link, and the resolved
language must be visible in `<html lang>`.

### 3.2 Reading surface

The mobile pass on the shared view: no horizontal scrolling anywhere, the
flowsheet as cards below the breakpoint, tap targets and type sizes that work
one-handed, and the flags block still above the fold on a small phone. The
print stylesheet per S12.

### 3.3 Loop and cost

The CTA redirect and its counter (S13); the translate-now step in the dialog
(S14); and the dialog copy that states the AI cost.

### 3.4 Carried polish

- The `scope` shape the Stage 2 review flagged: the list reports
  `{"kind":"all","from":null,"to":null}` while the create response and
  `meta.scope` report `{"kind":"all"}`. Normalize to one shape everywhere and
  assert it.
- `has_new_data` is true on **expired** rows, so the card can claim "new results
  since you shared" on a link nobody can open. Expired links should not carry
  the flag; revoked already wins over it.

---

## 4. Contracts

- `POST /api/share/links` gains `default_locale` (EN/RU or null), validated the
  same way as the rest of the body.
- `GET /api/share/cta` — public, tokenless, rate-limited, 302 to `/`, one
  counter row.
- `share_funnel_events.is_anonymous` becomes nullable; existing rows are
  unaffected.
- Nothing else about the public read path changes: same resolver, same uniform
  404, same `no-store`, same attachment and notes exclusions.

---

## 5. Testing

**Backend**: `default_locale` validation and round-trip; the CTA endpoint's
redirect target, its counter row, its rate limit, and that it accepts no token
and leaks nothing; the nullable sender flag; and the expired-row flag fix.

**Frontend**: the switch navigating with `?lang=` and never writing the cookie;
the resolver's new order, each step asserted; the link default taking effect
when no `?lang=` is present; the card layout below the breakpoint; the print
stylesheet's exclusions; the dialog's language control and the translate-now
path including its absence for anonymous senders; and the two polish fixes.

---

## 6. Doc sync

- `AGENTS.md` — the frontend invariant that spells the resolver order
  (`?lang=` → `Accept-Language` → `NEXT_LOCALE` → `en`) becomes false and must
  be updated; the public-share bullet gains the CTA endpoint and the nullable
  funnel flag.
- `frontend/docs/architecture.md` — the shared view's locale resolution, the
  mobile card layout, the print stylesheet.
- `backend/docs/architecture.md` — the CTA endpoint, the funnel table's two row
  kinds.
- `docs/phase-1.1-product-plan.md` §13 — Stage 3 as delivered, including the
  recorded deferral of 7-language chrome.

---

## 7. Risks

- **The language switch is the easiest place to break the no-cookie promise.**
  Any `setLocale` call on the shared tree writes `NEXT_LOCALE`. Assert it in a
  test, not just in review.
- **A responsive `FlowsheetMatrix` touches three surfaces** (owner flowsheet,
  shared view, `/demo`). If the owner's layout regresses, that is a worse trade
  than a shared-only card variant.
- **Print output is easy to forget** and hard to test; a real print-preview
  check belongs in the live verification.
- **A public counter endpoint is a new write surface.** Rate-limit it and make
  it increment nothing but a number.
- **Hebrew, when it comes, is a layout project** — the shared surface has no
  RTL support today and this plan does not add it.
