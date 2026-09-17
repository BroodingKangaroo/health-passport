"""Share-link lifecycle and the single public token resolver (roadmap 1.1).

``resolve_share_link`` is the only place a client-supplied string becomes a
tenant id. Everything on the public surface receives an already-resolved
:class:`ShareContext` and cannot widen it: the public router takes no tenant
identifier and no scope override, so a recipient can only ever read what the
link's owner chose.

Stage 1 fixed the link configuration (whole passport, 7 days, header on, notes
off, no attachments). Stage 2 lets the sender choose the scope and the expiry,
counts opens and tracks the new-data watermark. Nothing here widens the read
path: a scope only ever *narrows* what the builders return, and the resolver
still enforces revocation and expiry on every read.
"""

import hashlib
import hmac
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.db.models import (
    MedicalEntry,
    ShareFunnelEvent,
    ShareLink,
)

logger = logging.getLogger(__name__)

# "hp_" makes a leaked token identifiable to secret scanners and greppable in
# an incident; the body carries 256 bits of entropy.
TOKEN_PREFIX = "hp_"
TOKEN_BYTES = 32
# Default lifetime when the sender does not choose one — the shipped Stage 1
# behaviour stays the default.
SHARE_TTL_DAYS = 7
# Expiry choices, validated server-side against the principal (S4). Anonymous
# sessions are capped at 7 days (technical plan §11), so an anonymous link may
# not outlive its own session: 30 days is registered-only.
SHARE_EXPIRY_DAYS_REGISTERED = (1, 7, 30)
SHARE_EXPIRY_DAYS_ANONYMOUS = (1, 7)
# A refresh inside this window must not inflate ``open_count``: reopening the
# page is the same visit, and the counter exists to answer "did anyone look,
# and did they come back".
SHARE_OPEN_DEBOUNCE_SECONDS = 300
# Funnel events (S1) — sender actions only, never per recipient.
FUNNEL_LINK_CREATED = "link_created"
FUNNEL_LINK_REVOKED = "link_revoked"
# The one recipient-side counter (S13): a click on the public CTA redirect.
# Its funnel row carries ``is_anonymous = NULL`` — that is the flag that
# separates recipient counters from sender actions (see the model).
FUNNEL_CTA_CLICKED = "cta_clicked"

# The optional passcode (Stage 4, S15). Six is the floor the plan commits to:
# a four-character code is not a secret, and the copy must not imply that it
# is.
SHARE_PASSCODE_MIN_LENGTH = 6
# How long an unlock lasts. Short enough that a grant left in a tab is not a
# standing credential, long enough to read a record and its table.
SHARE_GRANT_TTL_SECONDS = 3600
# Domain separator: the same SECRET_KEY signs session tokens, and a grant must
# never be mistakable for one.
_GRANT_CONTEXT = "share-grant-v1"


def validate_passcode(passcode: Optional[str]) -> Optional[str]:
    """Return the passcode to hash, or ``None`` when the link is unprotected.

    Raises :class:`PasscodeError` for anything the create endpoint must refuse
    with a localized 400. Validation lives here rather than in the router so
    the minimum length cannot drift from the hash that stores it.
    """
    if passcode is None:
        return None
    if not isinstance(passcode, str):
        raise PasscodeError("length")
    if len(passcode) < SHARE_PASSCODE_MIN_LENGTH:
        raise PasscodeError("length")
    # bcrypt silently truncates past 72 bytes; refusing is honest about what
    # the code protects, and matches the account-password path's reasoning.
    # Its own kind, because telling a 73-byte code it is "at least 6
    # characters" is the wrong sentence (Stage 4 review, F6).
    if len(passcode.encode("utf-8")) > 72:
        raise PasscodeError("too_long")
    return passcode


class PasscodeError(ValueError):
    """A passcode the create endpoint must reject with a localized 400.

    Carries a stable ``kind`` ("length" / "too_long") rather than a localized
    string, the same pattern as :class:`ScopeError`.
    """

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


def _passcode_fingerprint(passcode_hash: Optional[str]) -> str:
    """A short, non-reversible stand-in for the stored passcode hash.

    The grant is signed over this rather than over the bcrypt hash itself, so
    a sender who sets a new passcode invalidates every outstanding grant
    without the server storing a token or a version counter for it. It is a
    fingerprint of a HASH, so it leaks nothing usable.
    """
    if not passcode_hash:
        return "-"
    return hashlib.sha256(passcode_hash.encode("utf-8")).hexdigest()[:16]


def issue_grant(link_id: str, passcode_hash: Optional[str]) -> tuple[str, int]:
    """Mint a short-lived unlock grant for one link. Returns (grant, ttl).

    HMAC-SHA256 over ``link_id | expiry | passcode fingerprint``, signed with
    the app secret. Nothing is stored: the grant is verifiable from the link
    row alone, and because the passcode fingerprint is part of the signed
    message, changing the passcode invalidates every grant already issued.
    """
    expires_at = int(datetime.now(timezone.utc).timestamp()) + SHARE_GRANT_TTL_SECONDS
    message = "|".join(
        (_GRANT_CONTEXT, link_id, str(expires_at), _passcode_fingerprint(passcode_hash))
    )
    signature = hmac.new(
        _grant_secret(), message.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{expires_at}.{signature}", expires_at


def _grant_secret() -> bytes:
    """The signing key, read lazily so a test can point it at its own value.

    ``app.auth`` resolves SECRET_KEY at import time; reading it here keeps one
    source of truth for the secret instead of copying it at import.
    """
    from app import auth

    return auth.SECRET_KEY.encode("utf-8")


def verify_grant(grant: Optional[str], link_id: str, passcode_hash: Optional[str]) -> bool:
    """Whether ``grant`` unlocks ``link_id`` right now.

    False for a missing, malformed, expired or mismatched grant — including a
    grant minted before the passcode changed, because the fingerprint is part
    of the signed message. Compared with :func:`hmac.compare_digest`.
    """
    if not grant:
        return False
    expires_raw, _, signature = grant.partition(".")
    if not expires_raw or not signature:
        return False
    try:
        expires_at = int(expires_raw)
    except ValueError:
        return False
    if expires_at <= int(datetime.now(timezone.utc).timestamp()):
        return False
    message = "|".join(
        (_GRANT_CONTEXT, link_id, str(expires_at), _passcode_fingerprint(passcode_hash))
    )
    expected = hmac.new(
        _grant_secret(), message.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def generate_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def allowed_expiry_days(is_anonymous: bool) -> tuple[int, ...]:
    return SHARE_EXPIRY_DAYS_ANONYMOUS if is_anonymous else SHARE_EXPIRY_DAYS_REGISTERED


class ScopeError(ValueError):
    """A scope the create endpoint must reject with a localized 400.

    ``kind`` is a stable marker ("kind" / "date" / "range") rather than a
    localized string: the router maps it to an i18n key, because the service
    layer has no request locale. Mirrors ``OCRProcessingError.kind``.
    """

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


# The four entry types that exist (models.MedicalEntry.type). Exclusions are
# deliberately the whole vocabulary rather than a per-entry curation UI: the
# point is "do not send my imaging" in one click (S16).
SHARE_ENTRY_TYPES = ("blood_test", "doctor_visit", "instrumental_test", "procedure")


class ExcludeError(ValueError):
    """An exclusion list the create endpoint must reject with a localized 400.

    ``kind`` is "type" (an unknown entry type) or "shape" (not a list, or a
    list the client padded with junk). Stable markers, mapped to i18n keys by
    the router, the same convention as :class:`ScopeError`.
    """

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


def normalize_exclude(raw: object) -> Optional[list[str]]:
    """Validate a create request's exclusion list into canonical form.

    Returns ``None`` when nothing is excluded (so an empty list and an absent
    list are the same stored value), otherwise the four known types in their
    canonical order. Any unknown type or non-list shape raises
    :class:`ExcludeError` — a client cannot park junk in the stored scope.
    """
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ExcludeError("shape")
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str) or item not in SHARE_ENTRY_TYPES:
            raise ExcludeError("type")
        seen.add(item)
    if not seen:
        return None
    return [entry_type for entry_type in SHARE_ENTRY_TYPES if entry_type in seen]


@dataclass(frozen=True)
class DateRange:
    """Inclusive whole-day window over ``MedicalEntry.date``.

    ``start`` / ``end`` are the UTC day boundaries (00:00:00.000000 of the
    ``from`` day and 23:59:59.999999 of the ``to`` day); printed dates are
    treated as UTC, matching the shipped Stage 1 interpretation of entry
    dates. Either end may be ``None`` (an open-ended window); ``None`` as a
    whole means "no filtering", i.e. the whole record.
    """

    start: Optional[datetime] = None
    end: Optional[datetime] = None


def _parse_scope_date(value: object) -> date:
    """Parse one end of a scope range at whole-day granularity."""
    if not isinstance(value, str) or not value.strip():
        raise ScopeError("date")
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise ScopeError("date") from exc


def _day_start(day: str) -> datetime:
    return datetime.combine(date.fromisoformat(day), time.min, tzinfo=timezone.utc)


def _day_end(day: str) -> datetime:
    return datetime.combine(date.fromisoformat(day), time.max, tzinfo=timezone.utc)


def normalize_scope(scope: Optional[dict]) -> Optional[dict]:
    """Validate and canonicalise a create request's scope.

    Returns ``None`` for the whole record with nothing excluded (the wire
    shape ``{"kind": "all"}``) or a canonical dict describing the window
    and/or the exclusions. Unknown kinds, unparseable dates and an inverted
    range raise :class:`ScopeError`; a bad exclusion list raises
    :class:`ExcludeError`; only known keys survive, so a client cannot park
    junk in the stored scope.

    ``exclude`` rides BOTH kinds (S16): "the last two years, but not the
    imaging" is one scope, not two features. The stored shape is
    ``{"kind": "all", "exclude": [...]}`` or
    ``{"kind": "range", "from": ..., "to": ..., "exclude": [...]}``, with the
    key absent when nothing is excluded.
    """
    if scope is None:
        return None
    if not isinstance(scope, dict):
        raise ScopeError("kind")
    kind = scope.get("kind")
    exclude = normalize_exclude(scope.get("exclude"))
    if kind == "all":
        # The whole record with an exclusion is still a narrowed read, so it
        # must be stored rather than collapsed to None.
        return {"kind": "all", "exclude": exclude} if exclude else None
    if kind != "range":
        raise ScopeError("kind")
    raw_from = scope.get("from")
    raw_to = scope.get("to")
    first = _parse_scope_date(raw_from) if raw_from is not None else None
    last = _parse_scope_date(raw_to) if raw_to is not None else None
    if first is not None and last is not None and first > last:
        raise ScopeError("range")
    normalized = {
        "kind": "range",
        "from": first.isoformat() if first else None,
        "to": last.isoformat() if last else None,
    }
    if exclude:
        normalized["exclude"] = exclude
    return normalized


def excluded_entry_types(scope: Optional[dict]) -> tuple[str, ...]:
    """The entry types a stored scope excludes, canonical order.

    Never raises: a row edited outside the app is served with its exclusions
    applied where they parse, and the caller logs the rest."""
    if not isinstance(scope, dict):
        return ()
    try:
        return tuple(normalize_exclude(scope.get("exclude")) or ())
    except ExcludeError:
        return ()


def date_range_from_scope(scope: Optional[dict]) -> Optional[DateRange]:
    """Translate a stored scope into the builders' ``date_range`` argument.

    The create path validates before storing, so a row can only carry ``None``
    or a well-formed range; a malformed value raises :class:`ScopeError` and
    the caller (the public read path) decides what to do about it.

    Since Stage 4 a scope may also be ``{"kind": "all", "exclude": [...]}`` —
    the whole record minus some entry types — which is no window at all and
    returns ``None`` here. The exclusions travel separately
    (:func:`excluded_entry_types`); this function only ever describes dates.
    """
    normalized = normalize_scope(scope)
    if normalized is None or normalized.get("kind") != "range":
        return None
    return DateRange(
        start=_day_start(normalized["from"]) if normalized["from"] else None,
        end=_day_end(normalized["to"]) if normalized["to"] else None,
    )


@dataclass(frozen=True)
class ShareContext:
    """What a public request is allowed to read, resolved from a raw token.

    Frozen on purpose: the public read path derives every tenant decision from
    this object, so it must not be mutable in place.
    """

    link_id: str
    owner_id: str
    scope: Optional[dict]
    include_header: bool
    default_locale: Optional[str]
    created_at: datetime
    expires_at: datetime
    # True when the link carries a passcode. The hash itself stays out of the
    # context: the read path only ever needs the boolean and the grant check.
    requires_passcode: bool = False


def record_watermark(db: Session, owner_id: str) -> Optional[datetime]:
    """The owner's newest data, as ``MAX(medical_entries.created_at)``.

    Both the new-data notice and the open stamps compare against this. Known
    and accepted limitation: it derives from ``created_at``, so deleting an
    entry does not move the watermark back. A dedicated ``record_changed_at``
    column stays deferred until a stamp proves load-bearing.
    """
    return (
        db.query(func.max(MedicalEntry.created_at))
        .filter(MedicalEntry.patient_id == owner_id)
        .scalar()
    )


def _funnel(db: Session, event: str, is_anonymous: Optional[bool]) -> None:
    db.add(ShareFunnelEvent(event=event, is_anonymous=is_anonymous))


def create_link(
    db: Session,
    owner_id: str,
    is_anonymous: bool,
    ttl_days: int = SHARE_TTL_DAYS,
    scope: Optional[dict] = None,
    include_header: bool = True,
    default_locale: Optional[str] = None,
    passcode_hash: Optional[str] = None,
) -> tuple[ShareLink, str]:
    """Create a link owned by ``owner_id`` and return ``(row, raw_token)``.

    ``scope`` must already be normalised by :func:`normalize_scope`,
    ``passcode_hash`` already produced by :func:`validate_passcode` +
    ``auth.get_password_hash``, and ``ttl_days`` already checked against
    :func:`allowed_expiry_days` — the router owns those decisions because they
    need the request locale and the principal. The raw token is returned
    exactly once; only its SHA-256 is stored, so the sender can never re-open
    the link from the list (technical plan §4.2). The raw passcode never
    reaches here at all: only its hash, which is what gets stored.

    ``notified_record_at`` starts at the owner's *current* watermark, so data
    that already existed when the link was made never raises a new-data
    notice. The funnel row and the link are one transaction: a "link_created"
    row exists exactly when the link does.
    """
    raw_token = generate_token()
    now = datetime.now(timezone.utc)
    link = ShareLink(
        id=uuid.uuid4().hex,
        token_hash=hash_token(raw_token),
        owner_id=owner_id,
        is_anonymous=is_anonymous,
        scope=scope,
        passcode_hash=passcode_hash,
        include_header=include_header,
        include_notes=False,
        default_locale=default_locale,
        open_count=0,
        created_at=now,
        expires_at=now + timedelta(days=ttl_days),
        notified_record_at=record_watermark(db, owner_id),
    )
    db.add(link)
    _funnel(db, FUNNEL_LINK_CREATED, is_anonymous)
    db.commit()
    db.refresh(link)
    return link, raw_token


def record_cta_click(db: Session) -> None:
    """Count one recipient CTA click: a funnel row with the sender flag NULL.

    The public CTA is tokenless by design (S13), so this row carries no link
    id and no recipient identity — it answers "clicks per link opened", which
    is the loop signal the roadmap asked for. NULL is the point: it marks the
    row as a recipient-side counter, the second kind of row the funnel table
    holds since Stage 3.
    """
    _funnel(db, FUNNEL_CTA_CLICKED, None)
    db.commit()


def resolve_share_link(db: Session, raw_token: Optional[str]) -> Optional[ShareLink]:
    """Look a raw token up by hash, rejecting missing, unknown, revoked and
    expired links identically (all return ``None``).

    Expiry is a SQL predicate rather than a Python comparison: the column is
    written tz-aware but SQLite hands it back naive, and comparing naive to
    aware datetimes raises.
    """
    if not raw_token:
        return None
    token = raw_token.strip()
    if not token:
        return None
    return (
        db.query(ShareLink)
        .filter(
            ShareLink.token_hash == hash_token(token),
            ShareLink.revoked_at.is_(None),
            ShareLink.expires_at > datetime.now(timezone.utc),
        )
        .first()
    )


def context_from_link(link: ShareLink) -> ShareContext:
    return ShareContext(
        link_id=link.id,
        owner_id=link.owner_id,
        scope=link.scope,
        include_header=bool(link.include_header),
        default_locale=link.default_locale,
        created_at=link.created_at,
        expires_at=link.expires_at,
        requires_passcode=bool(link.passcode_hash),
    )


def mark_opened(db: Session, link_id: str) -> bool:
    """Count one open, debounced — the feature's only write on a GET.

    One conditional UPDATE does everything: it increments ``open_count``,
    stamps ``first_opened_at`` only while it is still NULL, moves
    ``last_opened_at`` to now, and records the owner's current record
    watermark in ``first_open_record_at`` / ``last_open_record_at`` — so
    "came back after new data" is ``open_count > 1 AND last_open_record_at >
    first_open_record_at``.

    The debounce lives in the WHERE clause, not in a read-then-write: two
    concurrent opens cannot both pass the predicate, because the predicate is
    evaluated by the same statement that writes. A refresh inside
    ``SHARE_OPEN_DEBOUNCE_SECONDS`` therefore leaves no trace at all, not even
    a moved ``last_opened_at``. Returns whether this call counted.

    **Best-effort: a counter that cannot be written must never fail the read
    that triggered it.** The public read path holds a SQLite snapshot from its
    own SELECT, and SQLite refuses a write that would have to upgrade a stale
    snapshot (``SQLITE_BUSY_SNAPSHOT``); ``PRAGMA busy_timeout`` does not cover
    that case, because waiting can never make a stale snapshot current. So an
    ``OperationalError`` is logged, the transaction rolled back, and the open
    simply goes uncounted: an uncounted open is a metric we can lose, a 500 is
    a recipient who cannot see their record (Stage 4 review, F1).

    Deliberately NO retry. A retry was MEASURED to make contention worse: the
    fresh transaction no longer conflicts instantly, so it waits out
    ``busy_timeout`` instead, and because these reads are blocking DB work
    inside a single event loop, a burst compounds into a stall (30 simultaneous
    reads were still pending at 60 s). Failing fast and moving on is what keeps
    overlapping reads returning.

    The rollback is safe here because the public read path performs no other
    write in this session, and every caller builds its :class:`ShareContext`
    from plain values BEFORE calling this.
    """
    try:
        return _mark_opened_once(db, link_id)
    except OperationalError:
        # A stale read snapshot or a competing writer: give up on the counter.
        db.rollback()
        logger.warning(
            "Could not count an open for share link %s: another writer holds "
            "the lock. Serving the read anyway and losing the increment.",
            link_id,
        )
        return False


def _mark_opened_once(db: Session, link_id: str) -> bool:
    """One attempt at the debounced counting UPDATE."""
    now = datetime.now(timezone.utc)
    stale_before = now - timedelta(seconds=SHARE_OPEN_DEBOUNCE_SECONDS)

    # Return BEFORE touching the write lock when the link was already opened
    # inside the debounce window. The UPDATE's WHERE clause would reject it
    # anyway -- but only after taking SQLite's write lock, and taking that lock
    # on every refresh is what turned a burst of reads into contention. The
    # predicate stays in the WHERE clause too, so two concurrent opens still
    # cannot both pass it.
    last_opened = (
        db.query(ShareLink.last_opened_at).filter(ShareLink.id == link_id).scalar()
    )
    if last_opened is not None:
        if last_opened.tzinfo is None:
            last_opened = last_opened.replace(tzinfo=timezone.utc)
        if last_opened >= stale_before:
            return False

    watermark = (
        select(func.max(MedicalEntry.created_at))
        .where(MedicalEntry.patient_id == ShareLink.owner_id)
        .scalar_subquery()
    )
    updated = (
        db.query(ShareLink)
        .filter(
            ShareLink.id == link_id,
            or_(
                ShareLink.last_opened_at.is_(None),
                ShareLink.last_opened_at < stale_before,
            ),
        )
        .update(
            {
                ShareLink.open_count: ShareLink.open_count + 1,
                ShareLink.first_opened_at: func.coalesce(ShareLink.first_opened_at, now),
                ShareLink.last_opened_at: now,
                ShareLink.first_open_record_at: func.coalesce(
                    ShareLink.first_open_record_at, watermark
                ),
                ShareLink.last_open_record_at: watermark,
            },
            synchronize_session=False,
        )
    )
    if updated:
        db.commit()
    return bool(updated)


def list_owner_links(db: Session, owner_id: str) -> list[ShareLink]:
    """Every link the principal ever created, newest first — including expired
    and revoked rows, which are history, not garbage."""
    return (
        db.query(ShareLink)
        .filter(ShareLink.owner_id == owner_id)
        .order_by(ShareLink.created_at.desc(), ShareLink.id.desc())
        .all()
    )


def list_active_links(db: Session, owner_id: str) -> list[ShareLink]:
    """The principal's links that are neither revoked nor expired — the ones
    the new-data notice speaks for."""
    return (
        db.query(ShareLink)
        .filter(
            ShareLink.owner_id == owner_id,
            ShareLink.revoked_at.is_(None),
            ShareLink.expires_at > datetime.now(timezone.utc),
        )
        .all()
    )


def revoke_link(db: Session, owner_id: str, link_id: str) -> bool:
    """Revoke one of the principal's own links. Idempotent: revoking an
    already-revoked link succeeds. Returns False when the link does not exist
    or belongs to someone else — the caller must not distinguish the two.

    The write is a conditional UPDATE, so the "link_revoked" funnel row is
    written exactly once no matter how often the sender asks — including the
    ops script, which addresses the row by token and then calls this with
    ``link.owner_id`` / ``link.id``.
    """
    link = (
        db.query(ShareLink)
        .filter(ShareLink.id == link_id, ShareLink.owner_id == owner_id)
        .first()
    )
    if link is None:
        return False
    if link.revoked_at is None:
        updated = (
            db.query(ShareLink)
            .filter(ShareLink.id == link_id, ShareLink.revoked_at.is_(None))
            .update(
                {"revoked_at": datetime.now(timezone.utc)},
                synchronize_session=False,
            )
        )
        if updated:
            _funnel(db, FUNNEL_LINK_REVOKED, bool(link.is_anonymous))
        db.commit()
    return True


def revoke_all(db: Session, owner_id: str) -> int:
    """Revoke every active link the principal owns; returns how many closed.

    One "link_revoked" funnel row per link actually revoked, so an idempotent
    second call writes nothing at all. Each row is closed by its own
    conditional UPDATE rather than one bulk statement, because the funnel row
    (and its ``is_anonymous`` flag) belongs to a specific link.
    """
    revoked = 0
    now = datetime.now(timezone.utc)
    for link in list_active_links(db, owner_id):
        updated = (
            db.query(ShareLink)
            .filter(ShareLink.id == link.id, ShareLink.revoked_at.is_(None))
            .update({"revoked_at": now}, synchronize_session=False)
        )
        if updated:
            revoked += 1
            _funnel(db, FUNNEL_LINK_REVOKED, bool(link.is_anonymous))
    db.commit()
    return revoked


def acknowledge_notice(db: Session, owner_id: str) -> int:
    """Settle the new-data notice and report how many rows it touched.

    Every non-revoked link the principal owns is stamped with the *current*
    record watermark — expired links included, because their holder can no
    longer read anything and the notice must not outlive the links it speaks
    for. Revoked rows are left alone: they are closed history.
    """
    watermark = record_watermark(db, owner_id)
    touched = (
        db.query(ShareLink)
        .filter(ShareLink.owner_id == owner_id, ShareLink.revoked_at.is_(None))
        .update({ShareLink.notified_record_at: watermark}, synchronize_session=False)
    )
    db.commit()
    return touched
