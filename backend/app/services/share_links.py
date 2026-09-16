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
import secrets
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.models import (
    MedicalEntry,
    ShareFunnelEvent,
    ShareLink,
)

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

    Returns ``None`` for the whole record (the wire shape ``{"kind": "all"}``)
    or ``{"kind": "range", "from": "YYYY-MM-DD"|None, "to": ...}``. Unknown
    kinds, unparseable dates and an inverted range raise :class:`ScopeError`,
    and only the three known keys survive — a client cannot park junk in the
    stored scope.
    """
    if scope is None:
        return None
    if not isinstance(scope, dict):
        raise ScopeError("kind")
    kind = scope.get("kind")
    if kind == "all":
        return None
    if kind != "range":
        raise ScopeError("kind")
    raw_from = scope.get("from")
    raw_to = scope.get("to")
    first = _parse_scope_date(raw_from) if raw_from is not None else None
    last = _parse_scope_date(raw_to) if raw_to is not None else None
    if first is not None and last is not None and first > last:
        raise ScopeError("range")
    return {
        "kind": "range",
        "from": first.isoformat() if first else None,
        "to": last.isoformat() if last else None,
    }


def date_range_from_scope(scope: Optional[dict]) -> Optional[DateRange]:
    """Translate a stored scope into the builders' ``date_range`` argument.

    The create path validates before storing, so a row can only carry ``None``
    or a well-formed range; a malformed value raises :class:`ScopeError` and
    the caller (the public read path) decides what to do about it.
    """
    normalized = normalize_scope(scope)
    if normalized is None:
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
) -> tuple[ShareLink, str]:
    """Create a link owned by ``owner_id`` and return ``(row, raw_token)``.

    ``scope`` must already be normalised by :func:`normalize_scope` and
    ``ttl_days`` already checked against :func:`allowed_expiry_days` — the
    router owns those decisions because they need the request locale and the
    principal. The raw token is returned exactly once; only its SHA-256 is
    stored, so the sender can never re-open the link from the list (technical
    plan §4.2).

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
    """
    now = datetime.now(timezone.utc)
    stale_before = now - timedelta(seconds=SHARE_OPEN_DEBOUNCE_SECONDS)
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
