"""
Anonymous session handling utilities.
"""

import uuid

from fastapi import Request, Response

from config import ANONYMOUS_COOKIE_NAME


def get_or_create_anon_id(request: Request, response: Response) -> str:
    """
    Get anonymous ID from cookie or create new one.
    Cookie has NO expiration (persists until explicitly cleared).
    """
    anon_id = request.cookies.get(ANONYMOUS_COOKIE_NAME)
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
            value=anon_id,
            httponly=True,
            samesite="none" if is_secure else "lax",
            secure=is_secure,
            max_age=None  # No expiration - persists until cleared
        )
    return anon_id
