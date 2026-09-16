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
    once — only its hash is stored."""

    id: str
    token: str
    created_at: str
    expires_at: str
    scope: dict
    include_header: bool
    include_notes: bool


class ShareLinkSummary(BaseModel):
    id: str
    created_at: str
    expires_at: str
    # Null = still active. Expiry and revocation are evaluated on read, so the
    # UI derives the three sender-visible states from these two stamps.
    revoked_at: Optional[str] = None
    first_opened_at: Optional[str] = None
    is_anonymous: bool
    scope: dict
    include_header: bool
    include_notes: bool


class ShareLinkListResponse(BaseModel):
    links: list[ShareLinkSummary] = []


class ShareLinkRevokedResponse(BaseModel):
    success: bool = True
    id: str


class ShareLinksRevokedResponse(BaseModel):
    success: bool = True
    revoked: int = 0


__all__ = [
    "ShareLinkCreatedResponse",
    "ShareLinkListResponse",
    "ShareLinkRevokedResponse",
    "ShareLinkSummary",
    "ShareLinksRevokedResponse",
    "ShareRecordHeader",
    "ShareRecordMeta",
    "SharedBiomarkerDefinition",
    "SharedBiomarkerResult",
    "SharedRecordResponse",
]
