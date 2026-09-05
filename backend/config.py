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

# Chat LLM used by extraction + matcher helpers (OCR always uses the Mistral
# OCR endpoint and is unaffected by this knob). mistral-large-latest stopped
# being available on the subscription tier on 2026-08-29 (403 tier_not_allowed),
# so the default moved to mistral-medium-latest; override via .env if the tier
# regains a stronger model.
MISTRAL_CHAT_MODEL = os.environ.get("MISTRAL_CHAT_MODEL", "mistral-medium-latest")

# Per-call timeout (ms) for every matcher/translation LLM request. Without it
# a stalled call inherits the client's global 300s (× SDK retries) and one
# hung verify call stalls the SSE matching stage for minutes (ISSUES.md #58).
# Same 90s policy as the OCR call timeout in services/extractor.py.
LLM_CALL_TIMEOUT_MS = int(os.environ.get("LLM_CALL_TIMEOUT_MS", "90_000"))

# Email settings (password reset). SMTP_ENABLED gates delivery; when disabled
# (default, local dev) the reset link is logged instead.
SMTP_ENABLED = os.environ.get("SMTP_ENABLED", "").lower() in ("1", "true", "yes")
SMTP_HOST = os.environ.get("SMTP_HOST", "localhost")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "no-reply@healthpassport.local")
SMTP_TLS = os.environ.get("SMTP_TLS", "").lower() in ("1", "true", "yes")

# Batch import: staged extraction jobs (result + file) expire this many hours
# after their last update. Swept lazily (enqueue + list-read) by the import
# API — no scheduler.
IMPORT_JOB_TTL_H = int(os.environ.get("IMPORT_JOB_TTL_H", "72"))

# Number of background extraction worker threads (import jobs). Default 1:
# serial Mistral calls avoid the documented 429-contamination bug. Values >1
# stay unsupported until a rate-limit strategy exists (see docs).
