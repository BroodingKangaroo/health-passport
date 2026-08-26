"""
Anonymous session handling utilities.

The cookie value is HMAC-signed at issuance and verified on every read: the
raw client-supplied value is never trusted as the authorization principal.
Unsigned, tampered, or malformed values are treated exactly like a missing
cookie (a fresh signed session is issued).
"""

import hashlib
import hmac
import uuid
from typing import Optional

from fastapi import Request, Response

from app.auth import SECRET_KEY
from config import ANONYMOUS_COOKIE_NAME


def sign_anon_id(anon_id: str) -> str:
    """Return the cookie value carrying ``anon_id`` plus its HMAC signature."""
    digest = hmac.new(
        SECRET_KEY.encode(), anon_id.encode(), hashlib.sha256
    ).hexdigest()
    return f"{anon_id}.{digest}"


def verify_anon_cookie(value: Optional[str]) -> Optional[str]:
    """Return the anon id embedded in a correctly-signed ``anon-``-prefixed
    cookie value, else None. Constant-time signature comparison; legacy
    unsigned values fail (no separator) — hard cutover."""
    if not value:
        return None
    anon_id, sep, sig = value.rpartition(".")
    if not sep or not anon_id.startswith("anon-"):
        return None
    expected = hmac.new(
        SECRET_KEY.encode(), anon_id.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    return anon_id


def get_or_create_anon_id(request: Request, response: Response) -> str:
    """
    Get a verified anonymous ID from the signed cookie or create a new session.
    Cookie has NO expiration (persists until explicitly cleared).
    Returns the bare anon id (principal); only the cookie carries the signature.
    """
    anon_id = verify_anon_cookie(request.cookies.get(ANONYMOUS_COOKIE_NAME))
    if not anon_id:
        anon_id = f"anon-{uuid.uuid4().hex[:12]}"
        # SameSite=None is required for cross-site sends and always mandates
        # Secure, but on plain-HTTP origins (LAN IPs, non-TLS dev) a Secure
        # cookie is never sent, which broke anonymous sessions. So only mark
        # the cookie Secure (and keep SameSite=None) when the request is HTTPS;
        # otherwise fall back to SameSite=Lax so first-party HTTP still works.
        is_secure = (
            request.url.scheme == "https"
            or (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip() == "https"
        )
        response.set_cookie(
            key=ANONYMOUS_COOKIE_NAME,
            value=sign_anon_id(anon_id),
            httponly=True,
            samesite="none" if is_secure else "lax",
            secure=is_secure,
            max_age=None  # No expiration - persists until cleared
        )
    return anon_id
