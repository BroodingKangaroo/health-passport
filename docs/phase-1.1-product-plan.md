# Phase 1.1 — Shareable read-only link (product plan)

**Status:** draft for owner review — decisions in §6 are recommendations, not
settled.
**Date:** 2026-09-15.
**Source:** `docs/product-roadmap.md` §1.1 ("Shareable read-only link (killer
feature)"), constrained by the marketing principles (§2) and the Safety &
compliance guardrails at the end of the roadmap.
**Scope:** product only. No schemas, endpoints, migrations or components are
designed here. Where the current implementation constrains a product decision,
it is named as a constraint.

---

## 1. What this is

Today the only way a HealthPassport user gives their record to another person
is to print it: choose a layout, text size, columns, biomarkers, target
language, generate a PDF, send the file. The recipient gets a static page of
numbers in the sender's chosen language, and it stops being true the moment
the next lab report arrives.

Phase 1.1 replaces that with a link. The sender creates a link to their
passport, sends that link to a doctor or a relative, and the recipient opens
it in a browser with no account, on a phone, and sees the record as it is
right now. The link expires and can be revoked.

This is the only feature in the product where a person who has never heard of
HealthPassport experiences HealthPassport. Every print user, every demo
visitor, and every patient is inside the funnel already; a doctor holding a
link is the top of a second funnel. That is why it is the flagship.

---

## 2. The problem and the people

### 2.1 Who sends

The sender is a person who already has entries in the app. Against the three
personas:

- **Regular people (persona 1)** have a scattered record — a folder of PDFs,
  photos of printouts, a couple of clinics with separate portals. Their job
  when they see a new doctor is: *give this person the full picture in one
  step, without narrating my history from memory and without handing over a
  folder they will not read.*
- **Chronic-condition patients (persona 2)** own the trend story. Their job
  is: *show what has changed since the last visit*, because the trend is the
  clinically interesting part and it is exactly what a stack of separate lab
  reports hides.
- **Travelers (persona 3)** need the record presentable to a doctor who does
  not speak the sender's language, in a country where nobody can pull up the
  sender's history. Their job is: *be understood abroad, in the doctor's
  language, without carrying paper.*

The cross-cutting AI-hesitant audience matters here in one specific way: this
feature has to cost the sender almost no decisions. The current print setup
asks the sender to become a document designer — orientation, text size,
columns, per-biomarker filters, translation mode — at the exact moment they
are thinking about a medical appointment. The share flow should ask two or
three questions and then hand over a link.

### 2.2 Who receives

Two recipients, one view:

- **A doctor.** Has three to seven minutes, does not know the app, has never
  seen the sender's data before, and will judge the sender on whether the
  first screen is legible. The job: *tell me what is out of range, since
  when, and which way it is moving — do not make me read forty rows to find
  the two that matter.*
- **A relative** — often a partner or adult child who books appointments and
  holds the family's documents. The job: *help me understand what is going
  on and what to ask about*, with a lower tolerance for clinical framing and
  none for jargon.

The relative is easier: they know the sender and mostly need reassurance and
clarity. The doctor is the harder recipient and the one the feature's
reputation depends on. **v1 is designed for the doctor**; the relative is
served by the same view because flags-first, plainly labelled data reads fine
to a non-clinician too. Splitting into two modes (a "clinical" and a "family"
view) is a deferred candidate, not a v1 decision.

### 2.3 Why the PDF and the screenshot fail

The print passport is a good document. The problem is that it is a *file*.

- **It is stale the moment it is sent.** The next lab visit, the corrected
  reading, the doctor's note from Tuesday — none of it reaches the PDF in the
  recipient's inbox. The sender's only options are to re-send and hope the
  doctor opens the newer file, or to say "ignore the old one", which is
  exactly the version confusion the doctor does not have time for.
- **It cannot be revoked.** Once the file or the screenshot is in a thread,
  there is no take-back if the sender regrets it or shared too much.
- **It is unsorted.** The printed document is a longitudinal table organised
  by biomarker and date — a good research layout, a poor first screen. A
  doctor has to find the abnormal values themselves.
- **It is in one language, chosen by the sender for the whole document.**
- **It asks the sender to design it.** A bad use of the sender's attention at
  the wrong moment, and the result is inconsistent between sends.
- **A screenshot is strictly worse**: cropped, no reference range, no status,
  no trend, no context, and often unreadable.

The shared link fixes the staleness, the revocability, the ordering and the
language in one move. The print flow stays — some clinics want paper, and a
file works offline — and the share flow should be presented as its sibling,
not its replacement. Per marketing principle 3, both are sold the same way:
*arrive prepared, save your doctor's time.* The shared view must never read
as "here is my diagnosis"; it reads "here is my data, decoded, out-of-range
first."

---

## 3. What is actually in a passport

Grounding for §6, so the scope decisions are about real fields. Today's
persisted model (`backend/app/db/models.py`) holds:

- **Personal header** — name, date of birth, gender (`Patient`). The printed
  passport renders it at the top of the document when the sender is
  registered.
- **Entries**, four types, each with a date, title, subtitle, clinic,
  category and a free-text `notes` field:
  - **Blood test** — a list of biomarker readings. Each reading carries the
    value (numeric, or a qualitative text like "Detected"), the unit, the
    reference (an interval with low/high, or a qualitative expected value),
    the computed status (`low` / `normal` / `high` for intervals, `normal` /
    `abnormal` for qualitative, empty when unknown), the original name, value
    and range exactly as printed on the source document, and whether the
    value was scale-converted. Readings merged in from a later upload are
    marked as merged and appear only in the timeline details view — never in
    the flowsheet or the print document.
  - **Doctor visit** — specialty, provider, clinic, verdict/diagnosis, notes,
    prescriptions, recommendations.
  - **Instrumental test** — modality, findings, conclusion.
  - **Procedure** — title/date/clinic only.
- **Attachments** — the uploaded source documents themselves (the PDF or the
  photo), with a name, type and size, plus a per-entry document tab in the
  app.
- **Derived views** — the timeline, the flowsheet matrix (blood tests only,
  dates as columns), the correlation chart, and the print document.

Two properties of this data shape the product:

1. **Status is already computed and stored per reading.** "Out of range" is a
   fact the app holds, not something the shared view has to invent. That is
   what makes flags-first cheap and honest.
2. **The free-text fields are unbounded.** A visit `notes` field, a verdict
   string, an instrumental conclusion — any of them can contain anything the
   document contained, including a sensitive diagnosis the sender did not
   think about when they created the link. Attachments are worse: a scanned
   lab report routinely carries the sender's full name, address, insurance
   number, and sometimes a family member's data on the same page.

---

## 4. The recipient experience

### 4.1 The first 30 seconds

The page opens to one scrolling column, no login, no cookie wall, no banner
over the content. Top to bottom:

1. **A one-line orientation strip.** Whose record this is (per the sender's
   header choice), how fresh it is ("Last updated 12 Sep 2026"), and that the
   link expires ("This link expires 22 Sep 2026 — the owner can revoke it at
   any time"). This is the trust gesture: the recipient knows what they are
   looking at, that it is current, and that it will not exist forever.
2. **"Needs attention" — the flagged results, first.** Every currently
   out-of-range or abnormal reading, newest first, each as a card: biomarker
   name, the value with its unit, the reference range, and the date it was
   measured. The block is empty on a clean record and says so plainly ("No
   results outside the reference range in this record").
3. **"What changed" — a short trend line per flagged biomarker.** For a
   chronic patient this is the whole point: the last two or three values with
   direction ("0.9 → 1.4 → 2.1 since March"), drawn from the same series the
   flowsheet uses. Only for biomarkers with more than one reading.
4. **"Visits, imaging and procedures" — the non-lab history**, most recent
   first: date, type, clinic, the diagnosis/verdict line, and the
   recommendations as a short list.
5. **"All results" — the full longitudinal table**, biomarker rows against
   dates, the same structure the printed passport uses, for the doctor who
   wants to read it like a lab sheet.
6. **A footer** with the not-a-diagnosis line and, quietly, the conversion
   call to action (§11).

The order is the product decision: a doctor who reads only item 2 and stops
still got the useful part of the visit.

### 4.2 What the recipient can do

- Read everything the link grants, without expanding anything they do not
  want to.
- Open a biomarker or an entry to see the details behind a row — the original
  printed name, value and range as they appeared on the document.
- Print or save the page with the browser's own print (D3 in §6 explains why
  the source documents themselves are not part of v1).
- Switch the view's language, independent of the sender (§8).
- Tap the "Make your own HealthPassport" link, which leads to the public
  landing page.

### 4.3 What the recipient cannot do

- No editing, no uploads, no adding an entry, no commenting, no messaging the
  sender, no account required — and none of these is offered behind a
  "register to continue" wall. The link grants everything it grants on the
  first request.
- No access to anything the sender did not share: no other entries, no other
  links, no account identity beyond the header, no email address, no usage
  numbers.
- No recipient state is created. Opening a link must not mint an anonymous
  session, set a login cookie, or record anything about the recipient beyond
  an aggregated first-open signal for the sender (§7). A recipient who taps
  the CTA and starts their own record gets a fresh identity, not a
  continuation of the one they were browsing.

### 4.4 On a phone

The doctor's first look is a phone in a corridor, not a desktop. The shared
view is phone-first:

- One column. Cards for flags. No horizontal scrolling anywhere — the
  flowsheet matrix, which is a wide desktop-by-design table, is the last
  section and must degrade to per-biomarker cards on narrow screens rather
  than clip.
- Values and reference ranges at a size that is readable while walking, with
  status encoded as a word plus a color, never color alone.
- No sticky elements that eat the viewport, no modals, no welcome overlay.
- The recipient's print output drops the app chrome, the language switch and
  the CTA.

Calm and glanceable is a marketing principle, and on a shared view it is also
a clinical-utility requirement: the recipient has to be able to find the two
flagged values before their attention runs out.

### 4.5 Reading to someone with no account

The recipient has no context for the app. Copy must therefore never assume it:

- The not-a-diagnosis line is not optional and is not a small grey footnote:
  this is a personal health record kept by its owner, shown to you at their
  invitation, and it is not a medical opinion or a diagnosis.
- No mention of AI on the recipient surface in v1. The decoded numbers, the
  ranges and the statuses are the output; explaining how they were extracted
  invites questions about accuracy that the recipient cannot resolve and that
  the record cannot answer for them.
- Plain words for the framing, clinical words for the data. "Needs
  attention", "outside the reference range", "last updated" — not
  "abnormalities detected" or "risk".

### 4.6 Expired, revoked, or mistyped

One page, no ambiguity, no error code:

> This link is no longer active. If you still need this record, ask the person
> who shared it to send a new link.

Two rules on this page:

- **It never confirms what the link was.** No sender name, no record type, no
  "this link expired on" versus "this link was revoked" distinction — a
  stranger who guesses or finds a dead token learns nothing.
- **It hints at recovery without leaking the sender's identity**: "ask the
  person who shared it." If the recipient knows who sent it, that is enough.

Revocation takes effect immediately, on the next request, with no grace
window. An "it worked a second ago" experience is worse than a clean stop.

---

## 5. The sender experience

### 5.1 Where sharing lives

Sharing is a first-class action, not a setting. Two entry points, in this
order of prominence:

1. **Next to the existing print/export affordance** (the header's document
   flow). The sender's mental model — "give this to my doctor" — is the same
   one that currently leads to print setup, and that is where they will look.
   The share dialog should read as the lighter sibling: *Share a link* next to
   *Print / export*.
2. **A "Shared links" card on `/settings`**, alongside the existing export and
   danger-zone cards. This is where the sender goes to check, revoke, and
   understand what is out there. It is the permanent home of the feature; the
   header entry point is the shortcut.

An anonymous-session user reaches `/settings` by URL today (there is no
dropdown for them) — so the header entry point has to work for anonymous
senders without sending them through settings first.

### 5.2 What the sender chooses

Deliberately small. Three decisions, everything else fixed:

1. **Scope** — everything, or a date range (§6, D1/D2).
2. **Include my name and date of birth** — a single toggle, default per §6 D6.
3. **Expires in** — 1 day / 7 days / 30 days (§6, D8/D9).

Then: *Create link* → the link is shown with a copy button and the system
share sheet. Plain-language consequences appear with the link, not buried:

> Anyone with this link can view your passport until it expires. You can
> revoke it at any time. This link always shows your record as it is now — it
> updates as you add more.

The sender does not choose layout, columns, biomarkers, text size or
translation mode. Those belong to the print document.

### 5.3 Sending

v1 is **copy link plus the native share sheet** (WhatsApp, mail, Messages —
whatever the sender already uses). The app does not send the link itself.
Reason: sending from the app means building a deliverability surface, choosing
a mail body in the sender's voice, and inviting the sender to think the
recipient was *notified by us* — which makes a bounced or ignored message our
problem. Copy-link makes the sender the courier, which is also the honest
model for who is responsible for who receives clinical data.

Emailing the link from the app is a deferred candidate (§10): the mailer
already exists, so it is cheap to add later, but it changes the expectation in
a way that is better settled after v1 usage.

### 5.4 The link list, and the states a sender needs

The "Shared links" card is a list, newest first, in which every state is
visible and legible:

| State | What the sender sees |
|---|---|
| **Active** | When created, what scope, when it expires, whether it has been opened and when. A **Revoke** button. |
| **Expired** | The same row, greyed, "Expired {date}". No action needed. |
| **Revoked** | The same row, "Revoked {date}". Kept in the list on purpose. |

Rules:

- **Every link the sender ever created stays in the list.** The list is the
  single answer to "what is out there?" — a revoked link that vanishes leaves
  the sender guessing whether the revoke worked.
- **"Revoke all links"** sits at the card level. This is the panic button for
  the moment a sender realises they sent the wrong thing to the wrong person,
  and it must be one tap, not a hunt through rows.
- **The scope is shown in words, not stored as a configuration**: "Everything,
  as of {date}" or "Results from 1 Mar 2026 to 1 Sep 2026".

### 5.5 When the sender is not sure a link is still out there

This is the emotional core of the sender experience and it deserves a decision
rather than a hope. The answer is three things:

1. **The list shows every link and its state without the sender having to
   remember anything.**
2. **Revoke-all exists and is always visible.**
3. **The sender is told when new data becomes visible through an active link**
   (§7). This is the moment that otherwise surprises a sender — they add a
   mental-health visit note on Tuesday and forget that a link created in March
   is still live. A quiet inline notice ("2 active links can see your new
   results") converts a silent exposure into an informed one.

### 5.6 Anonymous senders

The roadmap makes links available to anonymous-session users, for funnel
consistency. Allowing it is the right call, with one constraint the roadmap
does not mention: **the anonymous sender's ability to revoke depends on
keeping their browser session.** The anonymous identity is a persistent
cookie; lose it and the links stay live until they expire, unrevocable.

So the anonymous case is allowed but bounded:

- A **shorter maximum expiry** for anonymous senders (§6, D11).
- A **visible consequence in the dialog**, stated at creation time: *Clear
  your browser data and you will no longer be able to revoke this link.*
- The same list and revoke-all, scoped to the session that created them.

This is a genuine product risk (§12, R3 and Q2), and it is the single decision
in this plan I would most want the owner to weigh in on.

---

## 6. Scope decisions

Each row is a decision with a recommendation. "Owner's call" marks the ones
where the recommendation is a judgement about the product's position, not a
derivable answer.

| # | Decision | Recommendation | Why | Owner's call |
|---|---|---|---|---|
| **D1** | What is shared by default | **Whole passport, as of the moment the recipient opens it** | The doctor's job is the whole picture; a default that forces the sender to pick a range makes "share my record" a configuration task. This is also what the roadmap specifies. | No |
| **D2** | Date-range sharing | **Offered, optional** — a "since" date or a from/to pair in whole months, not a per-entry picker | The real use is "what has changed since your last visit" (persona 2), which a range expresses in one choice. Per-entry selection is deferred (§10). | No |
| **D3** | Attachments / source documents | **Not shared in v1; the view may state that documents exist, but no previews or downloads** | Attachments are the highest-PII surface in the model: full name, address, insurance number, sometimes a family member on the same scan. The print passport does not include them either, and the shared view's job is decoding, not document delivery. This is the recommendation I am least certain of — see Q4. | **Yes** |
| **D4** | Free-text `notes` on entries | **Excluded — and not offered as a toggle** | `notes` is the only field with no schema; it is where the sender writes to themselves ("scared about this one", "ask about the thing at work"). Clinical fields are typed and expected; journaling is not. Stage 2 found the toggle has nothing to switch (entry notes never reached the shared payload at all), so it was dropped rather than left inert. | **Yes** |
| **D5** | Typed clinical fields — verdict/diagnosis, recommendations, prescriptions, findings, conclusion | **Included** | These are the doctor's own output and the core of "arrive prepared". A record that hides the diagnosis and the recommendations is not usable at a visit. | No |
| **D6** | Personal header (name, DOB, gender) | **On by default**, with one toggle to turn it off | **This deviates from the roadmap**, which says off by default. A doctor cannot safely act on labs without an identifier, and the link's secrecy — not the header — is what protects the record. Hiding the name while showing the results is privacy theatre that costs the feature its main use. See §14, F1. | **Yes** |
| **D7** | Recipient locale | **The recipient's own language, never the sender's.** Default from the browser, overridable on the page, optionally preset by the sender in the link | The traveler persona is why this matters: a Russian patient's German doctor should read German chrome. The sender setting it in the link is a convenience, never a lock. See §8. | Partly — see Q6 |
| **D8** | Default expiry | **7 days** | Long enough to cover the appointment and its follow-up, short enough that a forgotten link closes itself. The roadmap offers 7 or 30; 7 is the better default and 30 the better ceiling. | No |
| **D9** | Expiry choices | **1 day / 7 days / 30 days** | A day for the "one appointment" case, a month for a referral cycle. Three options is the most a sender will read. | No |
| **D10** | No-expiry links | **Not offered in v1** | An unlimited link is a permanent open door to clinical data, and the "promise" of revocation decays with the sender's memory. | No |
| **D11** | Who may create links | **Registered users and anonymous-session users.** Anonymous links capped at **7 days maximum** (1 or 7 only, no 30) | Roadmap-mandated, and consistent with the anonymous trial funnel. The cap and the warning in §5.6 are what keep an anonymous public surface defensible. | **Yes** |
| **D12** | Active-link count | **No product limit**; the list is the guard | Multiple links is the normal case (one per doctor). Expiry and revoke-all are the real controls; a cap would only create support friction. | No |
| **D13** | Readings the app knows are unreliable (`needs_review`, failed scale conversion) | **Excluded from the "Needs attention" flags and the trend lines; shown in the full table with a neutral "not standardised" mark** | A number the app could not convert must not appear as a confident flag to a clinician. Showing it in the full table preserves transparency and the source value. | No |
| **D14** | Recipient tracking | **First-open timestamp only, sender-visible.** No per-visit log, no IP, no device, no location, no "live viewer" indicator | The sender wants to know the doctor looked, not to watch them read. A viewer log turns a clinical tool into surveillance and invites the sender to refresh it. | **Yes** — see Q5 |
| **D15** | Merged readings | **Excluded from the shared view, matching the flowsheet and print rules** | An existing, documented contract: merged readings appear only in the timeline details view. The shared view must not become a third place where they leak. | No |

Two of these deserve prose:

**D6 — the header default.** The roadmap's "off by default for privacy" is the
one place where this plan argues with the roadmap. The reasoning: the link is a
bearer credential, so anyone who has it already sees everything the link
grants; the header adds an identifier, not the data. Meanwhile a doctor looking
at unlabelled labs has to ask whose they are, which is exactly the friction the
feature exists to remove. A better privacy default for the sender is a
*shorter expiry* and a *narrower scope*, not a nameless record. The toggle
stays on the dialog, so the sender who is sharing with a relative or who wants
to minimise exposure can turn it off in one tap.

**D4 — free-text notes.** Notes never travel, and this is a deliberate
asymmetry with D5: typed clinical fields travel, journaling does not. The
consequence to accept is that a useful note ("fasting sample, on a new
medication since March") is left behind, with no way for the sender to opt it
in. That is the right side to err on for a field that can contain anything:
the original plan offered a toggle, but the shared payload never carried entry
notes at all, so Stage 2 removed `include_notes` from the API surface instead
of shipping a control that could not do anything. A "notes traveled" mode is a
deferred candidate (§10) rather than a switch on the create dialog.

---

## 7. The live-link question

"Always-current" is the feature's best property and its sharpest risk. A link
that updates is a link whose contents the sender cannot fully predict at share
time.

### 7.1 What should be true

- **The recipient always sees the current data.** Never a cached snapshot from
  creation time. This is the difference from the PDF, and if it is not true
  the feature is a PDF with extra steps.
- **The recipient can tell how current it is.** The "Last updated {date}"
  stamp is part of the orientation strip, and each reading carries its own
  measurement date, so a value is never detached from when it was measured.
- **The sender is told, at share time, that the link keeps updating.** Not in
  small print: *This link shows your record as it is now and will update as
  you add more.* Otherwise senders build a mental model of a snapshot and are
  surprised in both directions.
- **The sender is told when new data lands on an active link** (§5.5). The
  notice names the link count, not the recipients ("2 active links can see
  your new results"), and it points at the revoke action.
- **A sender can never see whether a link is being read *right now*, and the
  recipient is never shown that the sender is watching.** D14's single
  first-open timestamp is the ceiling.

### 7.2 New data and the expiry

Recommendation: **new data never extends an expiry.** An expiry that moves is
not a promise the sender can make to a recipient or to themselves, and it
recreates the "when does this actually end?" uncertainty the feature exists to
remove. If a sender wants a longer window, they create a new link.

### 7.3 The two directions of trust

| Direction | The risk | The answer |
|---|---|---|
| **Sender shares before results are in** | The doctor opens a thin record and the sender looks disorganised; or the sender thinks they shared a snapshot and the abnormal result that arrived on Thursday was visible to a doctor who already decided. | The share dialog states the live behaviour; the recipient view shows "Last updated"; the sender gets the new-data notice. |
| **Sender forgets a link is open** | Data the sender would not have chosen to share becomes visible silently. | Default expiry; every link stays in the list with its state; revoke-all; the new-data notice; a maximum of 30 days with no unlimited option. |

### 7.4 Corrections and deletions

If the sender merges, corrects or deletes an entry, the recipient sees the
corrected record on their next view — including seeing a value disappear. That
is the correct behaviour for a live record and it should be stated in the
sender's copy, because a doctor who wrote down a number yesterday and finds it
gone today must not be left wondering whether the app is broken. The "Last
updated" stamp is the explanation.

---

## 8. Language and copy

Two independent language channels, already established in the repo, and the
shared view has to keep them separate:

- **UI chrome** (the shared view's own headings, buttons, empty states) —
  today's app is EN/RU next-intl catalogs. New keys belong in new `share` and
  `sharedView` catalogs with en/ru parity. The shared view **must not** read
  the sender's `NEXT_LOCALE` cookie; the recipient's browser language decides,
  a `?lang=` parameter or an in-page switch overrides, and the sender can
  optionally set the link's default language, which the recipient can still
  override. The recipient never has to sign in to change it.
- **Data names** — biomarker names come from the persisted `names[lang]`
  translations (the same 7-language flow the print document uses). The shared
  view reads whatever is already persisted and falls back per the existing
  print rules.

One firm rule: **the shared view never triggers a translation run.** Viewing a
link must not fire an LLM call — it would put unpredictable cost and latency
behind a public page that strangers can open. Fresh translation belongs in the
sender's share flow, as an optional "translate for this recipient" step that
reuses the existing translate-and-commit path; defer it.

For the traveler persona, this leaves a real gap worth naming: the chrome is
EN/RU, but the doctor may read German. The cheap bridge is to reuse the printed
passport's existing 7-language section headings where the shared view shows the
same concepts, so a German reader sees the same document language they would
have received as a PDF. Whether to take that further is Q6.

### Copy the feature needs

Sender side. EN string → RU proposal; final wording belongs in the catalogs,
and existing EN strings in other catalogs must not be reworded.

| Key concept | EN | RU |
|---|---|---|
| Entry point | Share a link | Поделиться ссылкой |
| Scope | Everything / From a date | Всё / Начиная с даты |
| Header toggle | Include my name and date of birth | Указать имя и дату рождения |
| Expiry | Expires in | Срок действия |
| Consequence | Anyone with this link can view your passport until it expires. You can revoke it at any time. | Любой, у кого есть эта ссылка, увидит вашу медкарту, пока срок действия не истёк. Вы можете отозвать её в любой момент. |
| Live behaviour | This link always shows your record as it is now — it updates as you add more. | Ссылка всегда показывает вашу медкарту в актуальном виде — она обновляется, когда вы добавляете новые данные. |
| Copied | Link copied | Ссылка скопирована |
| List | Shared links | Общие ссылки |
| List states | Active / Expired {date} / Revoked {date} | Активна / Истекла {date} / Отозвана {date} |
| Opened state | Opened {count} times, last {date} / Not opened yet | Открывали {count} раз, последний — {date} / Ещё не открывали |
| Scope in words | Whole record / {from} – {to} / From {date} / Until {date} | Вся карта / {from} – {to} / С {date} / До {date} |
| Revoke | Revoke | Отозвать |
| Panic button | Revoke all links | Отозвать все ссылки |
| New-data notice | {count} active links can see your new results | {count} активных ссылок видят ваши новые результаты |
| Anonymous warning | Clear your browser data and you will no longer be able to revoke this link. Anonymous links last at most 7 days. | Если вы очистите данные браузера, вы больше не сможете отозвать эту ссылку. Анонимные ссылки живут не дольше 7 дней. |

Dropped from the plan: the notes toggle (D4). Entry free-text never reaches
the shared payload, so there is no control to offer.

Recipient side:

| Key concept | EN | RU |
|---|---|---|
| Orientation | A personal health record shared with you by its owner | Личная медицинская карта, которой с вами поделился её владелец |
| Freshness | Last updated {date} | Обновлено {date} |
| Expiry | This link expires {date}. The owner can revoke it at any time. | Ссылка действует до {date}. Владелец может отозвать её в любой момент. |
| Flags block | Needs attention | Требует внимания |
| Empty flags | No results outside the reference range in this record | Нет показателей вне референсного диапазона |
| Trends | What changed | Что изменилось |
| History | Visits, imaging and procedures | Приёмы, обследования и процедуры |
| Full table | All results | Все результаты |
| Disclaimer | This is a personal record kept by its owner, not a diagnosis or medical advice. Discuss it with a doctor. | Это личная запись владельца, а не диагноз и не медицинская рекомендация. Обсудите её с врачом. |
| CTA | Make your own HealthPassport | Создайте свою HealthPassport |
| Dead link | This link is no longer active. If you still need this record, ask the person who shared it to send a new link. | Эта ссылка больше не активна. Если запись всё ещё нужна, попросите того, кто ею поделился, отправить новую ссылку. |

Status labels (`low` / `normal` / `high` / `abnormal` / unknown) reuse the
existing `statuses.*` keys — the shared view must not introduce a second
vocabulary for the same states.

---

## 9. Trust, privacy and safety

**Expiry and revocation are promises shown to the recipient, not settings.**
The orientation strip states the expiry and that the owner can revoke at any
time. That is marketing principle 4 in its strongest form: the recipient does
not have to trust the product, because the product told them exactly how long
they have and who can end it.

**A leaked link means the whole shared scope is exposed.** The token is the
credential; there is no second factor. The consequences the product accepts
and must communicate:

- Anyone holding the URL sees everything the link grants, including anyone it
  was forwarded to. The sender copy says this in those words.
- The shared view must not be discoverable — not indexed by search engines,
  not listed in a sitemap, and the token must not travel in a referrer header
  when a recipient follows the CTA out.
- The token must not be guessable and must not be derivable from an account id
  or a link count.
- Passcode protection ("this link also asks for a code") is the most likely
  first hardening addition, and it is deferred (§10) rather than dismissed.

**What the recipient can infer about the sender.** Only what the link
deliberately shows: the clinical content, and the header if the sender left it
on. The recipient cannot see the sender's email or account identity, cannot
tell whether other links exist, and cannot enumerate anything.

**What the recipient cannot be assumed to be.** The recipient is not
necessarily the intended one; the link may have been forwarded. Copy and
layout should never rely on the reader being the person the sender had in
mind.

**The applicable guardrails** (roadmap "Safety & compliance"):

- **No diagnosis claims.** The shared view repeats what the labs already say —
  a value, its reference range, and whether it is inside that range. It does
  not compute a risk, a severity, a prognosis or a direction of advice. The AI
  explanations of feature 1.2 are **not** exposed to recipients in v1: showing
  a clinician AI-generated "what this may mean" is a different product claim
  with a different review, and the sender has not opted into it.
- **Transparency.** Who shared it, what it contains, when it was updated, when
  it ends, and the not-a-diagnosis statement — all on the page.
- **Data ownership.** The shared view is read-only by construction; export and
  deletion keep working for the sender; deletion revokes what it should (Q7).
- **This is clinical data about a real person.** It is not a demo surface and
  not fictional. Every state — including the dead-link page — is written for
  that fact.

---

## 10. Non-goals and deferred candidates

Not in v1, with the reason each is deferred rather than rejected:

- **Selective per-entry or per-biomarker sharing.** Deferred, not rejected:
  the primary audience is one doctor who wants the picture, and per-item
  selection turns sharing into a curation task at the wrong moment. This is
  also the roadmap's own deferred candidate. Revisit when senders ask for it,
  or when a "hide this entry type" need shows up in the new-data-notice data.
- **Recipient accounts, comments, messaging, feedback.** Deferred: the
  conversation belongs in the visit. A comment box on clinical data is a
  support and moderation surface with no v1 owner.
- **Scheduled or recurring sharing** ("send my latest results every month").
  Deferred: it multiplies the expiry and revocation model, and the live link
  already covers "keep it current".
- **Snapshot / freeze links** ("stop updating this link"). Deferred: it is the
  opposite of the feature's promise, and it should be designed only if the
  live behaviour proves to confuse senders in practice.
- **Emailing the link from the app.** Deferred (§5.3): cheap to add later,
  wrong to add before the copy-link model is validated.
- **Attachments and one-click PDF/ZIP downloads.** Follows D3 and the
  roadmap's existing deferral of one-click PDF generation. Browser print is
  the v1 path.
- **Recipient-side read analytics** — per-visit logs, IP, device, location,
  live-viewer indicators. Deferred by D14; I would argue the live-viewer part
  is rejected rather than deferred.
- **Passcode-protected links.** Deferred: the most likely first hardening
  addition, once there is evidence of forwarded-link harm.
- **AI explanations on the recipient view.** Deferred (see §9): depends on
  feature 1.2.
- **A family/relative reading mode.** Deferred (§2.2): one view first, and let
  recipient feedback decide whether a second framing earns its upkeep.
- **Per-recipient link labels** ("Dad's cardiologist"). Deferred: nice for the
  sender's list, not needed to prove the loop.

---

## 11. How we would know it worked

**What the sender does**

- Share-link creation rate among users with at least one entry — does the
  affordance get found?
- Completion: created → copied or shared. A link created and never sent is a
  flow problem, not a usage problem.
- Scope and expiry distribution. A cluster of 30-day whole-passport links is a
  signal to watch for over-sharing, and it is the reason D6 and D8 are
  recommendations rather than defaults nobody chose.
- Revoke rate. Nonzero is healthy; very high means expiry is too generous or
  senders regret the scope.
- **Repeat sharing.** A sender who creates a second link has incorporated the
  feature into how they go to the doctor. This is the strongest sender signal.

**What the recipient does**

- Open rate: created → opened. This is the metric the whole feature turns on;
  a link nobody opens is a PDF with extra steps.
- Time to first open (before the appointment, or during it?).
- Depth: did the recipient scroll past the flags block, expand a biomarker,
  reach the full table? Flags-only reading is fine and expected; a zero rate
  for anything beyond the first screen means the lower sections are not
  earning their place.
- **Return visits within 30 days** — the doctor coming back to the same link,
  which is the live-link promise actually working.
- **Re-open after new data.** Did the recipient look again after the sender
  added results? This is the specific behaviour no PDF can produce, and the
  best single validation of §7.

**The viral loop**

- Click-through rate on "Make your own HealthPassport" from the shared view.
- Shared-view visit → landing → first upload, and the share of new signups that
  arrived from a link. The roadmap asks for a *subtle* CTA; the guardrail is
  that the CTA must not compete with the record for attention. If the
  click-through is high but record engagement drops, the CTA is too loud.
- Whether recipient-originated users share their own links (the loop's second
  turn).

**Qualitative evidence**

- Three to five senders who used a link at a real appointment, asked
  afterwards: did the doctor open it, did the sender have to explain it, did
  the visit change? That question cannot be answered by telemetry.
- Three to five recipients, including at least one doctor: what was the first
  thing you looked for, and did you find it in the first screen?
- The support and abuse inbox: forwarded-link complaints, dead-link confusion,
  and anything where a recipient saw something the sender did not intend.

**Instrumentation note.** Nothing in the repo measures any of this today.
Recipient-side events (open, first-open timestamp) and sender-side events
(created, opened-link, revoked) need a defined home before launch, or the
feature ships blind — see Q9. Whatever is collected must stop where the
recipient's privacy begins: the open signal belongs to the sender's link, not
to the recipient's identity.

---

## 12. Risks and open questions

### Risks

- **R1 — Over-sharing with no recourse.** A link forwarded into a group chat
  exposes the record to people the sender never considered. *Mitigation:*
  short default expiry, a 30-day ceiling, revoke-all, plain-language
  consequence copy, and a token that cannot be indexed or accidentally
  referred onward.
- **R2 — New sensitive data becomes visible silently.** Because the link is
  live, an entry the sender would not have chosen to share — a mental-health
  visit, a sensitive result — appears without a decision. *Mitigation:* the
  new-data notice (§5.5). *Follow-on:* per-entry-type exclusions are deferred
  (§10), and this risk is the strongest argument for promoting them.
- **R3 — Anonymous senders cannot revoke after losing a session.** The
  revocation promise is weaker for exactly the users the roadmap wants to
  include. *Mitigation:* a 7-day cap and explicit copy. *Open:* Q2.
- **R4 — Abuse: publishing a third party's records.** Nothing stops a bad
  actor from uploading someone else's documents and sharing a link. *Open:*
  Q10; the mitigations available today are short expiry, revocation and an
  abuse-reporting path.
- **R5 — A clinician treats the app's flags as authoritative.** If the app's
  curated reference range disagrees with the lab's, a confident red flag is
  wrong. *Mitigation:* the reading's own reference and original printed range
  are shown, D13 keeps unstandardised values out of the flags, and the
  disclaimer is on the page rather than in a footnote.
- **R6 — Recipient friction kills the loop.** A cookie banner, a login wall, a
  slow first paint on a phone, or flags below the fold all cost the feature
  its only chance with a given doctor. The recipient view is a lead surface
  with a performance budget, not an app route.
- **R7 — The "not-a-diagnosis" framing is misread as a hedge.** The line has
  to read as respect for the doctor's judgement, matching principle 3, not as
  a disclaimer the product is hiding behind.
- **R8 — Sensitive content in a scanned page.** Even with D3 (no attachments)
  or with the header off, a visit's findings text or a conclusion string can
  contain more than the sender remembers. D6's toggle does not fix this; only
  scope and expiry do.

### Open questions for the owner

The `Q…` ids below are **local to this document** — the technical plan
(`docs/phase-1.1-technical-plan.md` §19) numbers its own questions
independently, so "Q2" here is not "Q2" there. Cite the document when quoting
an id.

| # | Question | Why the repo cannot answer it | Recommendation |
|---|---|---|---|
| **Q1** | Should the personal header default to on or off? | The roadmap says off; the doctor's job says on. This is a positioning judgement. | **On by default**, one toggle (D6). |
| **Q2** | May anonymous-session users create links at all? | The roadmap says yes for funnel reasons; the revocation weakness is not addressed there. | **Yes**, capped at 7 days, with an explicit cookie warning (D11, §5.6). |
| **Q3** | Is the free-text `notes` field in or out? | Unknowable from the code; it depends on what real senders write there. | **Out, permanently** (D4). Stage 2 confirmed the field never reached the shared payload, so the planned toggle was dropped and `include_notes` left the API surface. |
| **Q4** | Do attachments travel with the link? | Depends on whether real doctors bounce off a decoded table and ask for the original report. | **Out in v1** (D3); revisit with the first recipient interviews. This is the decision I would most expect to reverse. |
| **Q5** | How much does the sender get to see about recipient activity? | Nothing in the repo expresses an intent here; it is a product-ethics call. | **First-open timestamp only** (D14); no per-visit log, no live indicator. |
| **Q6** | How many languages should the shared view's *chrome* support? | The app is EN/RU; the traveler persona implies more. | **EN/RU chrome in v1**, reusing the printed passport's 7-language headings where they overlap; expand if traveler usage shows up. |
| **Q7** | What happens to links when the account or session is deleted? | Not addressed in the roadmap. | **Account deletion kills every link immediately** (ownership). Anonymous session loss leaves links live until expiry but unrevocable — say so in the warning. |
| **Q8** | Is there a cap on active links? | No product reason found. | **No cap** (D12); add one only if abuse appears. |
| **Q9** | Where do recipient and sender share metrics live? | The repo has one write-only funnel table and no metrics stack; error tracking and dashboards are explicitly unscheduled. | **Answered in Stage 2**: `share_funnel_events` mirrors `ImportFunnelEvent`, records sender actions only (`link_created` / `link_revoked`), and carries no recipient identity. Recipient-side signals are the opaque `open_count` / `last_opened_at` counters, not events. |
| **Q10** | What is the abuse and takedown path for a published third party's records? | Not addressed anywhere in the repo. | Define a **report path and a removal process** before public launch; it is a precondition, not a v1.1 nice-to-have. |
| **Q11** | Legal posture: is the sender always the controller of their own shared data? | Requires a human/legal call; it also affects the privacy policy text. | Keep the consumer framing ("the owner shares their own record") and get it reviewed before launch. |
| **Q12** | Does the recipient's view need to say *whose* record it is when the header is off? | Product judgement about the relative case. | Leave it unlabelled and let the sender's scope choice carry the meaning; the relative knows who sent the link. |

---

## 13. Build order

Each stage is independently reviewable and useful on its own.

**Stage 1 — The link works (the loop's minimum).**

One link type: whole passport, 7-day expiry, header on, notes off, no
attachments. Create → copy → the recipient view. The recipient view carries the
orientation strip, the "Needs attention" block, the history section, the full
table, the disclaimer, and the CTA. Revocation happens from the same place the
link was created. EN/RU chrome, persisted 7-language names, the "Last updated"
stamp, phone-first layout.

This ships the proof: a doctor sees HealthPassport working, and a sender can
take it back.

**Stage 2 — Control and awareness.**

The "Shared links" card with all three states, revoke-all, the first-open
timestamp, the expiry choice (1/7/30), the anonymous cap and its warning, the
date-range scope, the header toggle, and the new-data notice on active links.
The notes toggle was dropped once Stage 2 confirmed entry notes never reach the
shared payload (D4). Also Stage 1's own measurement: sender events, recipient
open, and return-after-new-data events.

This is where the feature stops being a demo and starts being a trust
instrument.

**Stage 3 — Reach and polish.**

The recipient language switch (and the sender's optional link language), the
mobile pass on the shared view with the flowsheet degrading to cards, print
styling for a printed shared view, the CTA instrumentation, and the sender's
"translate for this recipient" step if the traveler need is real.

**Stage 4 — Deferred candidates, on their own evidence.**

Passcode-protected links, snapshot links, per-entry-type exclusions, and
attachments each get their own decision when Stage 1–3 data says which one
matters.

---

## 14. Where this plan disagrees with the roadmap

The roadmap's 1.1 framing is sound and unusually concrete; four things in it
are either wrong or missing, and they change what gets built.

1. **F1 — The personal header default is the wrong way round.** The roadmap
   specifies off by default; §6 D6 argues for on, because the link's secrecy is
   the protection and the identifier is what makes the record usable by a
   doctor. This is the plan's clearest disagreement.
2. **F2 — "Always-current" is treated as a pure benefit.** It is one for the
   recipient. For the sender it creates the silent-exposure problem (R2): new
   sensitive data becomes visible through links the sender has stopped thinking
   about. The roadmap does not mention this, and it needs the new-data notice
   in v1 rather than in a later phase.
3. **F3 — The anonymous-sender note stops one step short.** The roadmap grants
   links to anonymous users without addressing that their revocation ability
   dies with their session (R3, Q2). Recommendation: keep the access, cap the
   expiry, and say so on the screen.
4. **F4 — Two recipients are named, one experience is described, and no
   measurement is specified.** The recipient section is written for a doctor,
   but the relative has a different job and the roadmap never says which one
   v1 optimises for (§2.2). Separately, "the viral loop" is asserted without
   any signal for whether it fires (§11, Q9); without instrumentation the
   flagship ships unmeasurable, which for the feature that is supposed to
   bring in non-users is the costliest gap of the four.

The roadmap also leaves three questions the plan had to answer itself: what
happens to links on account deletion (Q7), what a leaked link implies in
practice (§9), and whether the shared view shows AI-generated explanations —
which the roadmap's 1.1 does not mention and 1.2 does not restrict. This plan
recommends keeping 1.2's explanations off the recipient view entirely, and that
boundary should be written down in whichever of the two features ships first.
