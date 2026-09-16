"""Share-link lifecycle and the single public token resolver (roadmap 1.1).

``resolve_share_link`` is the only place a client-supplied string becomes a
tenant id. Everything on the public surface receives an already-resolved
:class:`ShareContext` and cannot widen it: the public router takes no tenant
identifier and no scope override, so a recipient can only ever read what the
link's owner chose.

Stage 1 fixes the link configuration (whole passport, 7 days, header on,
notes off, no attachments). The row already carries the columns the later
stages expose, and the public payload is built from the row — so widening the
configuration later is a change to the create dialog, not to the read path.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.db.models import ShareLink

# "hp_" makes a leaked token identifiable to secret scanners and greppable in
# an incident; the body carries 256 bits of entropy.
TOKEN_PREFIX = "hp_"
TOKEN_BYTES = 32
# Stage 1 ships one fixed lifetime. Anonymous sessions are capped at the same
# 7 days (technical plan §11), so the cap cannot be violated until the
# sender-facing expiry choice lands with Stage 2.
SHARE_TTL_DAYS = 7


def generate_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


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
    include_notes: bool
    default_locale: Optional[str]
    created_at: datetime
    expires_at: datetime


def create_link(
    db: Session,
    owner_id: str,
    is_anonymous: bool,
    ttl_days: int = SHARE_TTL_DAYS,
) -> tuple[ShareLink, str]:
    """Create a link owned by ``owner_id`` and return ``(row, raw_token)``.

    The raw token is returned exactly once — only its SHA-256 is stored, so
    the sender can never re-open the link from the list (technical plan §4.2).
    """
    raw_token = generate_token()
    now = datetime.now(timezone.utc)
    link = ShareLink(
        id=uuid.uuid4().hex,
        token_hash=hash_token(raw_token),
        owner_id=owner_id,
        is_anonymous=is_anonymous,
        scope=None,
        include_header=True,
        include_notes=False,
        default_locale=None,
        created_at=now,
        expires_at=now + timedelta(days=ttl_days),
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return link, raw_token


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
        include_notes=bool(link.include_notes),
        default_locale=link.default_locale,
        created_at=link.created_at,
        expires_at=link.expires_at,
    )


def mark_first_opened(db: Session, link_id: str) -> None:
    """Record the first successful public read, once.

    A conditional UPDATE (not a read-then-write) so two concurrent first reads
    cannot race the stamp to a later timestamp. This is the feature's only
    write on a GET; the sender-visible consequence is one timestamp, never a
    per-visit log.
    """
    updated = (
        db.query(ShareLink)
        .filter(ShareLink.id == link_id, ShareLink.first_opened_at.is_(None))
        .update(
            {"first_opened_at": datetime.now(timezone.utc)},
            synchronize_session=False,
        )
    )
    if updated:
        db.commit()


def list_owner_links(db: Session, owner_id: str) -> list[ShareLink]:
    """Every link the principal ever created, newest first — including expired
    and revoked rows, which are history, not garbage."""
    return (
        db.query(ShareLink)
        .filter(ShareLink.owner_id == owner_id)
        .order_by(ShareLink.created_at.desc(), ShareLink.id.desc())
        .all()
    )


def revoke_link(db: Session, owner_id: str, link_id: str) -> bool:
    """Revoke one of the principal's own links. Idempotent: revoking an
    already-revoked link succeeds. Returns False when the link does not exist
    or belongs to someone else — the caller must not distinguish the two."""
    link = (
        db.query(ShareLink)
        .filter(ShareLink.id == link_id, ShareLink.owner_id == owner_id)
        .first()
    )
    if link is None:
        return False
    if link.revoked_at is None:
        link.revoked_at = datetime.now(timezone.utc)
        db.commit()
    return True


def revoke_all(db: Session, owner_id: str) -> int:
    """Revoke every active link the principal owns; returns how many closed."""
    count = (
        db.query(ShareLink)
        .filter(ShareLink.owner_id == owner_id, ShareLink.revoked_at.is_(None))
        .update(
            {"revoked_at": datetime.now(timezone.utc)},
            synchronize_session=False,
        )
    )
    if count:
        db.commit()
    return count
