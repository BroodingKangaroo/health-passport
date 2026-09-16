"""Wire shapes for the public share surface (roadmap 1.1).

The record payload embeds the existing timeline keys (``events``,
``biomarkers``, ``visits``, ``instrumental``) unchanged, so the frontend's
timeline types and components apply to a shared record with no second
vocabulary. ``meta`` and ``header`` are the only additions; they are what the
recipient's orientation strip renders.
"""

from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.biomarker import BiomarkerDefinition, BiomarkerResult
from app.schemas.common import TimelineResponse


class SharedBiomarkerDefinition(BiomarkerDefinition):
    """Owner-facing verification flag: the recipient has no use for it, so it
    is dropped from the public payload rather than sent as False (technical
    plan §5.2/§10)."""

    canonical_unit_inferred: bool = Field(default=False, exclude=True)


class SharedBiomarkerResult(BiomarkerResult):
    definition: SharedBiomarkerDefinition


class ShareRecordMeta(BaseModel):
    """The orientation strip's data: how fresh the record is and how long the
    link lives."""

    created_at: str
    expires_at: str
    last_updated: str
    # {"kind": "all"} or {"kind": "range", "from": ..., "to": ...}
    scope: dict
    default_locale: Optional[str] = None


class ShareRecordHeader(BaseModel):
    """The owner's personal header, present only when the link includes it and
    the owner is a registered principal (an anonymous session has no name or
    date of birth to share)."""

    name: str = ""
    dob: str = ""
    gender: str = ""


class SharedRecordResponse(TimelineResponse):
    meta: ShareRecordMeta
    header: Optional[ShareRecordHeader] = None
    biomarkers: list[SharedBiomarkerResult]


class ShareLinkCreatedResponse(BaseModel):
    """The create response. ``token`` is the raw value and is returned exactly
    once — only its hash is stored.

    ``include_notes`` is deliberately absent (Stage 2, S3): entry free-text
    notes never travel on a shared record, so the toggle left the API surface
    and the DB column behind it is unread.
    """

    id: str
    token: str
    created_at: str
    expires_at: str
    scope: dict
    include_header: bool
    default_locale: Optional[str] = None


class ShareLinkCreateRequest(BaseModel):
    """The create body (Stage 2, S4-S6): how long the link lives, what range of
    the record it may show, and whether the owner's header travels with it.

    ``expiry_days`` is validated against the principal in the router (the
    allowed sets differ for anonymous and registered senders); ``scope`` is a
    range or nothing; ``default_locale`` (Stage 3, S10) is the sender's
    per-link language preset, ``"en"`` / ``"ru"`` or None (the recipient's
    browser decides). All are server-side rules, never just hidden UI.
    """

    # Whole-record default: None means {"kind": "all"}.
    expiry_days: int = 7
    scope: Optional[dict] = None
    include_header: bool = True
    default_locale: Optional[str] = None


class ShareLinkSummary(BaseModel):
    """One row of the sender's "Shared links" list.

    Everything the card renders is computed server-side — the client never
    derives the state, and never learns a token (only its hash exists).
    """

    id: str
    created_at: str
    expires_at: str
    revoked_at: Optional[str] = None
    first_opened_at: Optional[str] = None
    open_count: int = 0
    last_opened_at: Optional[str] = None
    is_anonymous: bool
    # {"kind": "all", "from": None, "to": None} or
    # {"kind": "range", "from": "YYYY-MM-DD"|None, "to": ...}.
    scope: dict
    include_header: bool
    # The sender's per-link language preset (Stage 3, S10): "en" / "ru" or
    # None when the recipient's browser decides.
    default_locale: Optional[str] = None
    # "active" | "expired" | "revoked" — revoked wins over expired.
    state: str
    # True when the owner's record is newer than what this link has been
    # acknowledged for (never true for a revoked link).
    has_new_data: bool = False


class ShareLinkListResponse(BaseModel):
    links: list[ShareLinkSummary] = []


class ShareNoticeResponse(BaseModel):
    """The sender's new-data notice. A pure read: ``show`` is computed on
    every request and is never acknowledged as a side effect of asking."""

    active_links: int = 0
    show: bool = False


class ShareNoticeAckResponse(BaseModel):
    success: bool = True
    acknowledged: int = 0


class ShareLinkRevokedResponse(BaseModel):
    success: bool = True
    id: str


class ShareLinksRevokedResponse(BaseModel):
    success: bool = True
    revoked: int = 0


__all__ = [
    "ShareLinkCreateRequest",
    "ShareLinkCreatedResponse",
    "ShareLinkListResponse",
    "ShareLinkRevokedResponse",
    "ShareLinkSummary",
    "ShareLinksRevokedResponse",
    "ShareNoticeAckResponse",
    "ShareNoticeResponse",
    "ShareRecordHeader",
    "ShareRecordMeta",
    "SharedBiomarkerDefinition",
    "SharedBiomarkerResult",
    "SharedRecordResponse",
]
