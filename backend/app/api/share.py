"""Share links: the owner-side lifecycle and the public read surface.

Two clearly separated halves in one file (technical plan §5): sender routes
under ``/api/share/links`` authenticate with the normal principal dependency
and address a link by ``id``; public routes under ``/api/share`` take the raw
token in the ``X-Share-Token`` header and go through
:func:`resolve_share_context`, the one place a client-supplied string becomes
a tenant id.

The token is never part of an API path or query string. The API paths here are
constants, so a live credential appears in no access log, proxy log or
exception line — the repo has no log-scrubbing layer, and whatever is in a
path is written to stdout and copied into bug reports.

The public surface is GET-only and reads only this router. No existing
endpoint gains an alternative auth path, so no write endpoint is one
dependency-swap away from being public.
"""

import logging
import threading
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import i18n
from app.api.auth import get_current_user_or_anon
from app.api.flowsheet import _build_flowsheet
from app.api.timeline import (
    _biomarkers_from_db,
    _events_from_db,
    _instrumental_from_db,
    _visits_from_db,
)
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
)
from app.db.models import (
    Patient,
)
from app.db.models import (
    ShareLink as ShareLinkModel,
)
from app.db.session import get_db
from app.schemas.common import FlowsheetResponse
from app.schemas.share import (
    SharedBiomarkerResult,
    SharedRecordResponse,
    ShareLinkCreatedResponse,
    ShareLinkListResponse,
    ShareLinkRevokedResponse,
    ShareLinksRevokedResponse,
    ShareLinkSummary,
    ShareRecordHeader,
    ShareRecordMeta,
)
from app.services import share_links

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/share", tags=["share"])

SHARE_TOKEN_HEADER = "X-Share-Token"

# The public surface is unauthenticated, so a stolen or guessed token must not
# also be a free enumeration channel. Same in-memory sliding-window pattern the
# auth endpoints use: per-process, reset on restart, keyed by client IP only —
# never by token — so a 429 cannot confirm that a token exists.
#
# The budget is generous. A real reader loads the record once and then the
# flowsheet, and a shared page may be re-opened a few times; the limit exists
# to stop floods, not to meter a doctor.
_PUBLIC_READ_LIMIT = 600
_PUBLIC_READ_WINDOW_S = 60.0
# Cap on the map itself: the public surface is reachable by anyone with
# arbitrary source IPs, so without a bound it would keep one permanent deque
# per IP ever seen.
_PUBLIC_MAX_KEYS = 10_000
_public_windows: dict[str, deque] = defaultdict(deque)
_public_lock = threading.Lock()


def _public_requests_allowed(client_ip: str) -> bool:
    now = datetime.now(timezone.utc).timestamp()
    with _public_lock:
        window = _public_windows[client_ip]
        while window and now - window[0] > _PUBLIC_READ_WINDOW_S:
            window.popleft()
        allowed = len(window) < _PUBLIC_READ_LIMIT
        if allowed:
            window.append(now)
    _prune_public_keys()
    return allowed


def _prune_public_keys() -> None:
    """Bound the in-memory public read map (same shape as the auth throttle's
    ``_prune_throttle_keys``).

    A window whose entries are all older than the read window can never affect
    a decision again, so it is dropped — that is what bounds the map when each
    request comes from a distinct IP. A burst of distinct IPs can still exceed
    the cap inside one window, so the least-recently-active windows are evicted
    down to it; memory stays bounded by construction."""
    now = datetime.now(timezone.utc).timestamp()
    with _public_lock:
        for key, window in list(_public_windows.items()):
            while window and now - window[0] > _PUBLIC_READ_WINDOW_S:
                window.popleft()
            if not window:
                del _public_windows[key]
        over = len(_public_windows) - _PUBLIC_MAX_KEYS
        if over <= 0:
            return
        evicted = 0
        for key, _ in sorted(_public_windows.items(), key=lambda kv: kv[1][-1])[:over]:
            del _public_windows[key]
            evicted += 1
    logger.warning(
        "Public share throttle map exceeded %d keys — evicted %d least-recently-active windows",
        _PUBLIC_MAX_KEYS, evicted,
    )


def reset_public_throttle() -> None:
    """Clear the public read windows (the counter is per-process memory)."""
    with _public_lock:
        _public_windows.clear()


def _iso_utc(value: datetime) -> str:
    """ISO-8601 with an explicit UTC offset. SQLite drops tzinfo, so a naive
    value read back is UTC — and an expiry must be unambiguous to a client that
    parses it."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _scope_payload(scope: Optional[dict]) -> dict:
    return scope if isinstance(scope, dict) else {"kind": "all"}


async def resolve_share_context(
    request: Request,
    db: Session = Depends(get_db),
    token: Optional[str] = Header(default=None, alias=SHARE_TOKEN_HEADER),
) -> share_links.ShareContext:
    """The single enforcement point of the public surface.

    Missing, unknown, revoked and expired tokens all produce one response: the
    same 404 with the same localized detail, so a stranger who finds a dead
    token learns nothing about what it was. On success the first open is
    stamped once.
    """
    client_ip = request.client.host if request.client else "unknown"
    if not _public_requests_allowed(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=i18n.tr("share.too_many_requests"),
        )
    link = share_links.resolve_share_link(db, token)
    if link is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=i18n.tr("share.link_unavailable"),
        )
    context = share_links.context_from_link(link)
    share_links.mark_first_opened(db, context.link_id)
    return context


def _no_store(response: Response) -> None:
    """Revocation is effective on the next request only because nothing
    between the recipient and this resolver may cache: these are security
    controls, not performance preferences."""
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"


def _header_from_owner(db: Session, owner_id: str) -> Optional[ShareRecordHeader]:
    owner = db.query(Patient).filter(Patient.id == owner_id).first()
    if owner is None:
        # Anonymous principal: no name or date of birth exists to share.
        return None
    return ShareRecordHeader(
        name=owner.name or "",
        dob=owner.dob or "",
        gender=owner.gender or "",
    )


def _last_updated(db: Session, owner_id: str, fallback: datetime) -> datetime:
    newest = (
        db.query(func.max(MedicalEntryModel.created_at))
        .filter(MedicalEntryModel.patient_id == owner_id)
        .scalar()
    )
    return newest or fallback


def _build_shared_record(
    db: Session, context: share_links.ShareContext
) -> SharedRecordResponse:
    """Build the recipient payload from the same builders the authed timeline
    uses, with three deliberate differences (technical plan §5.2): attachments
    never travel, merged readings are excluded (D15), and the owner-facing
    inferred-unit flag is dropped.
    """
    biomarkers = [
        SharedBiomarkerResult.model_validate(result.model_dump())
        for result in _biomarkers_from_db(db, context.owner_id, include_merged=False)
    ]
    return SharedRecordResponse(
        meta=ShareRecordMeta(
            created_at=_iso_utc(context.created_at),
            expires_at=_iso_utc(context.expires_at),
            last_updated=_iso_utc(
                _last_updated(db, context.owner_id, context.created_at)
            ),
            scope=_scope_payload(context.scope),
            default_locale=context.default_locale,
        ),
        header=(
            _header_from_owner(db, context.owner_id)
            if context.include_header
            else None
        ),
        events=_events_from_db(db, context.owner_id, include_attachments=False),
        biomarkers=biomarkers,
        visits=_visits_from_db(db, context.owner_id, include_attachments=False),
        instrumental=_instrumental_from_db(
            db, context.owner_id, include_attachments=False
        ),
    )


@router.get("/record", response_model=SharedRecordResponse)
async def get_shared_record(
    response: Response,
    context: share_links.ShareContext = Depends(resolve_share_context),
    db: Session = Depends(get_db),
) -> SharedRecordResponse:
    """The recipient's record, as it is right now."""
    _no_store(response)
    return _build_shared_record(db, context)


@router.get("/flowsheet", response_model=FlowsheetResponse)
async def get_shared_flowsheet(
    response: Response,
    context: share_links.ShareContext = Depends(resolve_share_context),
    db: Session = Depends(get_db),
) -> FlowsheetResponse:
    """The full longitudinal table, requested separately so it never weighs
    down the recipient's first paint."""
    _no_store(response)
    dates, matrix, biomarkers = _build_flowsheet(db, context.owner_id)
    return FlowsheetResponse(dates=dates, matrix=matrix, biomarkers=biomarkers)


def _link_summary(link: ShareLinkModel) -> ShareLinkSummary:
    return ShareLinkSummary(
        id=link.id,
        created_at=_iso_utc(link.created_at),
        expires_at=_iso_utc(link.expires_at),
        revoked_at=_iso_utc(link.revoked_at) if link.revoked_at else None,
        first_opened_at=(
            _iso_utc(link.first_opened_at) if link.first_opened_at else None
        ),
        is_anonymous=bool(link.is_anonymous),
        scope=_scope_payload(link.scope),
        include_header=bool(link.include_header),
        include_notes=bool(link.include_notes),
    )


@router.post(
    "/links",
    response_model=ShareLinkCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_share_link(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
) -> ShareLinkCreatedResponse:
    """Create a link to the caller's own record.

    Stage 1 fixes the configuration (whole passport, 7 days, header on, notes
    off, no attachments); the create dialog is the later stage's work. The
    response is the only time the raw token exists.
    """
    _user, owner_id, is_anonymous = user_data
    link, raw_token = share_links.create_link(db, owner_id, is_anonymous)
    return ShareLinkCreatedResponse(
        id=link.id,
        token=raw_token,
        created_at=_iso_utc(link.created_at),
        expires_at=_iso_utc(link.expires_at),
        scope=_scope_payload(link.scope),
        include_header=bool(link.include_header),
        include_notes=bool(link.include_notes),
    )


@router.get("/links", response_model=ShareLinkListResponse)
async def list_share_links(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
) -> ShareLinkListResponse:
    """Every link the caller ever created, newest first — expired and revoked
    rows included, because the sender's history is the point."""
    _user, owner_id, _is_anonymous = user_data
    return ShareLinkListResponse(
        links=[
            _link_summary(link) for link in share_links.list_owner_links(db, owner_id)
        ]
    )


@router.post("/links/{link_id}/revoke", response_model=ShareLinkRevokedResponse)
async def revoke_share_link(
    link_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
) -> ShareLinkRevokedResponse:
    """Close one of the caller's links immediately. Idempotent, and a link
    belonging to someone else is indistinguishable from one that does not
    exist."""
    _user, owner_id, _is_anonymous = user_data
    if not share_links.revoke_link(db, owner_id, link_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=i18n.tr("share.link_not_found"),
        )
    return ShareLinkRevokedResponse(id=link_id)


@router.post("/links/revoke-all", response_model=ShareLinksRevokedResponse)
async def revoke_all_share_links(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
) -> ShareLinksRevokedResponse:
    """The sender's escape hatch when they are not sure what is still out
    there: close every active link they own in one call."""
    _user, owner_id, _is_anonymous = user_data
    return ShareLinksRevokedResponse(revoked=share_links.revoke_all(db, owner_id))
