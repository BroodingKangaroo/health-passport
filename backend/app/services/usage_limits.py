"""
Service for tracking and enforcing usage limits for both anonymous and registered users.
"""

from datetime import datetime, timezone
from typing import Optional, Tuple
from sqlalchemy.orm import Session

from app.db.models import UsageLimit
from config import (
    ANONYMOUS_LIMITS,
    REGISTERED_LIMITS,
)

# Convert MB to bytes
ANON_STORAGE_BYTES = ANONYMOUS_LIMITS["storage_mb"] * 1024 * 1024
REGISTERED_STORAGE_BYTES = REGISTERED_LIMITS["storage_mb"] * 1024 * 1024


def get_limits(db: Session, user_id: str, is_anonymous: bool) -> dict:
    """Get current usage and limits for a user."""
    max_ai = ANONYMOUS_LIMITS["ai_extractions"] if is_anonymous else REGISTERED_LIMITS["ai_extractions"]
    max_storage = ANON_STORAGE_BYTES if is_anonymous else REGISTERED_STORAGE_BYTES

    usage = db.query(UsageLimit).filter(
        UsageLimit.user_id == user_id,
        UsageLimit.is_anonymous == is_anonymous
    ).first()

    return {
        "is_anonymous": is_anonymous,
        "ai_extraction_count": usage.ai_extraction_count if usage else 0,
        "ai_extraction_limit": max_ai,
        "total_upload_size_bytes": usage.total_upload_size_bytes if usage else 0,
        "total_upload_limit_bytes": max_storage,
    }


def check_and_record_ai_usage(db: Session, user_id: str, is_anonymous: bool) -> tuple[bool, int, int]:
    """
    Check if AI usage is allowed and record it.
    Returns (allowed, current_count, limit).
    """
    max_ai = ANONYMOUS_LIMITS["ai_extractions"] if is_anonymous else REGISTERED_LIMITS["ai_extractions"]

    usage = db.query(UsageLimit).filter(
        UsageLimit.user_id == user_id,
        UsageLimit.is_anonymous == is_anonymous
    ).first()

    if usage and usage.ai_extraction_count >= max_ai:
        return (False, usage.ai_extraction_count, max_ai)

    if not usage:
        usage = UsageLimit(
            user_id=user_id,
            is_anonymous=is_anonymous,
            ai_extraction_count=0,
            total_upload_size_bytes=0,
        )
        db.add(usage)
        db.flush()

    usage.ai_extraction_count += 1
    usage.last_activity = datetime.now(timezone.utc)
    db.commit()
    return (True, usage.ai_extraction_count, max_ai)


def check_and_record_storage_usage(
    db: Session, user_id: str, size_bytes: int, is_anonymous: bool
) -> tuple[bool, int, int, int]:
    """
    Check if storage usage is allowed and record it.
    Returns (allowed, current_bytes, limit_bytes, remaining_bytes).
    """
    max_storage = ANON_STORAGE_BYTES if is_anonymous else REGISTERED_STORAGE_BYTES

    usage = db.query(UsageLimit).filter(
        UsageLimit.user_id == user_id,
        UsageLimit.is_anonymous == is_anonymous
    ).first()

    if not usage:
        usage = UsageLimit(
            user_id=user_id,
            is_anonymous=is_anonymous,
            ai_extraction_count=0,
            total_upload_size_bytes=0,
        )
        db.add(usage)
        db.flush()

    new_total = usage.total_upload_size_bytes + size_bytes
    if new_total > max_storage:
        return (False, usage.total_upload_size_bytes, max_storage, max_storage - usage.total_upload_size_bytes)

    usage.total_upload_size_bytes = new_total
    usage.last_activity = datetime.now(timezone.utc)
    db.commit()
    return (True, new_total, max_storage, max_storage - new_total)


def get_usage_record(db: Session, user_id: str, is_anonymous: bool) -> Optional[UsageLimit]:
    """Get the usage limit record for a user."""
    return db.query(UsageLimit).filter(
        UsageLimit.user_id == user_id,
        UsageLimit.is_anonymous == is_anonymous
    ).first()
