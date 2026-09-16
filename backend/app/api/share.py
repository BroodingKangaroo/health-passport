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
from fastapi.responses import RedirectResponse
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
    ShareLinkCreateRequest,
    ShareLinkListResponse,
    ShareLinkRevokedResponse,
    ShareLinksRevokedResponse,
    ShareLinkSummary,
    ShareNoticeAckResponse,
    ShareNoticeResponse,
    ShareRecordHeader,
    ShareRecordMeta,
)
from app.services import share_links

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/share", tags=["share"])

SHARE_TOKEN_HEADER = "X-Share-Token"

# A rejected scope carries a machine-readable kind, never a localized string:
# the service layer runs without a request locale (the create path is authed,
# but the same helper serves the locale-free read path).
_SCOPE_ERROR_KEYS = {
    "kind": "share.scope_unknown_kind",
    "date": "share.scope_invalid_date",
    "range": "share.scope_invalid_range",
}

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


def _as_utc(value: datetime) -> datetime:
    """Same normalisation as :func:`_iso_utc`, for comparisons rather than for
    serialization: SQLite hands tz-aware columns back naive, so two stamps can
    only be compared after one of them is re-anchored to UTC."""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _is_newer(candidate: Optional[datetime], reference: Optional[datetime]) -> bool:
    """Whether the record watermark is newer than a notification/open stamp.

    A missing candidate (an account with no entries at all) is never newer; a
    missing reference (never acknowledged, or a Stage 1 row that predates the
    watermark) counts as "older than everything", so the sender is told once
    rather than never.
    """
    if candidate is None:
        return False
    if reference is None:
        return True
    return _as_utc(candidate) > _as_utc(reference)


def _scope_payload(scope: Optional[dict]) -> dict:
    return scope if isinstance(scope, dict) else {"kind": "all"}


def _link_state(link: ShareLinkModel, now: datetime) -> str:
    """``active`` / ``expired`` / ``revoked`` — computed here, never by the
    client. Revocation wins over expiry: the sender closed the link, and that
    is the more useful fact."""
    if link.revoked_at is not None:
        return "revoked"
    if _as_utc(link.expires_at) <= now:
        return "expired"
    return "active"


def _date_range_for_context(context: share_links.ShareContext):
    """The link's scope as the builders' ``date_range`` argument.

    The create path validates before storing, so this can only fail on a row
    edited outside the app. That case is logged loudly and served as the whole
    record — the same behaviour Stage 1 had — rather than turning a recipient's
    page into a 500."""
    try:
        return share_links.date_range_from_scope(context.scope)
    except share_links.ScopeError:
        logger.error(
            "Share link %s carries an unparseable scope %r — serving the whole record",
            context.link_id, context.scope,
        )
        return None


async def resolve_share_context(
    request: Request,
    db: Session = Depends(get_db),
    token: Optional[str] = Header(default=None, alias=SHARE_TOKEN_HEADER),
) -> share_links.ShareContext:
    """The single enforcement point of the public surface.

    Missing, unknown, revoked and expired tokens all produce one response: the
    same 404 with the same localized detail, so a stranger who finds a dead
    token learns nothing about what it was. On success the open is counted
    (debounced — see ``share_links.mark_opened``).
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
    share_links.mark_opened(db, context.link_id)
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
    return share_links.record_watermark(db, owner_id) or fallback


def _build_shared_record(
    db: Session, context: share_links.ShareContext
) -> SharedRecordResponse:
    """Build the recipient payload from the same builders the authed timeline
    uses, with four deliberate differences (technical plan §5.2): attachments
    never travel, merged readings are excluded (D15), the owner-facing
    inferred-unit flag is dropped, and the link's date scope narrows every
    section — the entry set, and therefore each biomarker's reading history,
    visits, instrumental data and the flowsheet.
    """
    date_range = _date_range_for_context(context)
    biomarkers = [
        SharedBiomarkerResult.model_validate(result.model_dump())
        for result in _biomarkers_from_db(
            db, context.owner_id, include_merged=False, date_range=date_range
        )
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
        events=_events_from_db(
            db, context.owner_id, include_attachments=False, date_range=date_range
        ),
        biomarkers=biomarkers,
        visits=_visits_from_db(
            db, context.owner_id, include_attachments=False, date_range=date_range
        ),
        instrumental=_instrumental_from_db(
            db, context.owner_id, include_attachments=False, date_range=date_range
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
    down the recipient's first paint. Same scope, so the columns are exactly
    the blood tests the record payload showed."""
    _no_store(response)
    dates, matrix, biomarkers = _build_flowsheet(
        db, context.owner_id, date_range=_date_range_for_context(context)
    )
    return FlowsheetResponse(dates=dates, matrix=matrix, biomarkers=biomarkers)


def _link_summary(
    link: ShareLinkModel, watermark: Optional[datetime], now: datetime
) -> ShareLinkSummary:
    return ShareLinkSummary(
        id=link.id,
        created_at=_iso_utc(link.created_at),
        expires_at=_iso_utc(link.expires_at),
        revoked_at=_iso_utc(link.revoked_at) if link.revoked_at else None,
        first_opened_at=(
            _iso_utc(link.first_opened_at) if link.first_opened_at else None
        ),
        open_count=link.open_count or 0,
        last_opened_at=(
            _iso_utc(link.last_opened_at) if link.last_opened_at else None
        ),
        is_anonymous=bool(link.is_anonymous),
        scope=_scope_payload(link.scope),
        include_header=bool(link.include_header),
        default_locale=link.default_locale,
        state=_link_state(link, now),
        has_new_data=(
            link.revoked_at is None
            and _as_utc(link.expires_at) > now
            and _is_newer(watermark, link.notified_record_at)
        ),
    )


@router.post(
    "/links",
    response_model=ShareLinkCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_share_link(
    payload: Optional[ShareLinkCreateRequest] = None,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
) -> ShareLinkCreatedResponse:
    """Create a link to the caller's own record.

    Stage 2 lets the sender choose the scope, the lifetime and whether the
    header travels. Entry notes never travel, and no attachment ever does. The
    expiry is validated against the principal HERE, not just hidden in the
    dialog, so the server cap and the UI cannot drift apart. The response is
    the only time the raw token exists.
    """
    _user, owner_id, is_anonymous = user_data
    request = payload or ShareLinkCreateRequest()

    allowed = share_links.allowed_expiry_days(is_anonymous)
    if request.expiry_days not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr(
                "share.expiry_not_allowed",
                allowed=", ".join(str(days) for days in allowed),
            ),
        )
    if request.default_locale not in (None, "en", "ru"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("share.locale_not_allowed"),
        )
    try:
        scope = share_links.normalize_scope(request.scope)
    except share_links.ScopeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr(_SCOPE_ERROR_KEYS[exc.kind]),
        ) from exc

    link, raw_token = share_links.create_link(
        db,
        owner_id,
        is_anonymous,
        ttl_days=request.expiry_days,
        scope=scope,
        include_header=request.include_header,
        default_locale=request.default_locale,
    )
    return ShareLinkCreatedResponse(
        id=link.id,
        token=raw_token,
        created_at=_iso_utc(link.created_at),
        expires_at=_iso_utc(link.expires_at),
        scope=_scope_payload(link.scope),
        include_header=bool(link.include_header),
        default_locale=link.default_locale,
    )


@router.get("/cta")
async def share_cta(
    request: Request,
    db: Session = Depends(get_db),
) -> RedirectResponse:
    """Count a recipient's click through to the landing page and send them
    there (Stage 3, S13).

    Tokenless by design: per-link attribution would need the raw token in a
    URL, which the public surface forbids everywhere else. The one counter
    row goes to the funnel table with the sender flag NULL — a
    recipient-side counter, not a sender action. This is the only public
    write besides the debounced open counter, so it is rate-limited like
    every public read and must stay a number, never a channel.
    """
    client_ip = request.client.host if request.client else "unknown"
    if not _public_requests_allowed(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=i18n.tr("share.too_many_requests"),
        )
    share_links.record_cta_click(db)
    redirect = RedirectResponse(url="/", status_code=status.HTTP_302_FOUND)
    # Headers land on the RETURNED response, not an injected one: FastAPI only
    # merges injected-Response headers when the handler is not returning its
    # own Response, so the 302 would otherwise ship without them.
    _no_store(redirect)
    return redirect


@router.get("/links", response_model=ShareLinkListResponse)
async def list_share_links(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
) -> ShareLinkListResponse:
    """Every link the caller ever created, newest first — expired and revoked
    rows included, because the sender's history is the point.

    A read: the state, the open counters and ``has_new_data`` are all computed
    from the stored row plus the owner's current record watermark. Nothing is
    acknowledged here — that is ``POST /api/share/notice/ack``.
    """
    _user, owner_id, _is_anonymous = user_data
    watermark = share_links.record_watermark(db, owner_id)
    now = datetime.now(timezone.utc)
    return ShareLinkListResponse(
        links=[
            _link_summary(link, watermark, now)
            for link in share_links.list_owner_links(db, owner_id)
        ]
    )


@router.get("/notice", response_model=ShareNoticeResponse)
async def get_share_notice(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
) -> ShareNoticeResponse:
    """Whether to show the sender "N active links can see your new results".

    True only while at least one link is still active and the record has moved
    past the newest thing this owner has acknowledged for those links. A read
    in the strict sense: it writes nothing, so the notice cannot be cleared by
    looking at it (or by two windows racing).
    """
    _user, owner_id, _is_anonymous = user_data
    active = share_links.list_active_links(db, owner_id)
    watermark = share_links.record_watermark(db, owner_id)
    acknowledged = max(
        (link.notified_record_at for link in active if link.notified_record_at),
        default=None,
    )
    return ShareNoticeResponse(
        active_links=len(active),
        show=bool(active) and _is_newer(watermark, acknowledged),
    )


@router.post("/notice/ack", response_model=ShareNoticeAckResponse)
async def acknowledge_share_notice(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
) -> ShareNoticeAckResponse:
    """Clear the new-data notice: stamp the record's current watermark on every
    non-revoked link the caller owns (expired ones included — they are settled
    too) and report how many rows that touched."""
    _user, owner_id, _is_anonymous = user_data
    return ShareNoticeAckResponse(
        acknowledged=share_links.acknowledge_notice(db, owner_id)
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
