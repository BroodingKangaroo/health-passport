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
        # Cookie must be first-party (via the Next.js /api proxy) or, when hit
        # cross-origin, sent back on fetch with credentials. SameSite=None is
        # required for cross-site sends and always mandates Secure.
        # localhost / 127.0.0.1 are secure contexts (dev works); prod must use HTTPS.
        response.set_cookie(
            key=ANONYMOUS_COOKIE_NAME,
            value=anon_id,
            httponly=True,
            samesite='none',
            secure=True,
            max_age=None  # No expiration - persists until cleared
        )
    return anon_id
