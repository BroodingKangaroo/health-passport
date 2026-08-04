"""
Application configuration including usage limits.
"""

import os

# Usage limits configuration
ANONYMOUS_LIMITS = {
    "ai_extractions": 5,
    "storage_mb": 50,
}

REGISTERED_LIMITS = {
    "ai_extractions": 50,
    "storage_mb": 200,
}

# Convert MB to bytes for convenience
ANON_STORAGE_BYTES = ANONYMOUS_LIMITS["storage_mb"] * 1024 * 1024
REGISTERED_STORAGE_BYTES = REGISTERED_LIMITS["storage_mb"] * 1024 * 1024

# Cookie settings
ANONYMOUS_COOKIE_NAME = "healthpassport_anon_id"

# Public base URL of the frontend, used to build password-reset links. Never
# derived from request headers: the Origin/Referer of a direct API call is
# attacker-controlled and would let a caller rewrite the emailed link to a
# phishing domain holding a valid reset token.
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")

# Email settings (password reset). SMTP_ENABLED gates delivery; when disabled
# (default, local dev) the reset link is logged instead.
SMTP_ENABLED = os.environ.get("SMTP_ENABLED", "").lower() in ("1", "true", "yes")
SMTP_HOST = os.environ.get("SMTP_HOST", "localhost")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "no-reply@healthpassport.local")
SMTP_TLS = os.environ.get("SMTP_TLS", "").lower() in ("1", "true", "yes")
