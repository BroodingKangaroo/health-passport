"""
Application configuration including usage limits.
"""

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
