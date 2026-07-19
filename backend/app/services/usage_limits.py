"""
Service for tracking and enforcing usage limits for both anonymous and registered users.
"""

from datetime import datetime, timezone
from typing import Optional, Tuple
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
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


def check_and_record_ai_usage(db: Session, user_id: str, is_anonymous: bool, commit: bool = True) -> tuple[bool, int, int]:
    """
    Check if AI usage is allowed and record it.
    Returns (allowed, current_count, limit).

    `commit=False` defers the commit to the caller's transaction (used so a
    failed request does not persist a quota increment it never earned).

    The increment is performed as a single conditional UPDATE
    (count < limit) so concurrent requests cannot both read "under limit"
    and both pass — the second UPDATE affects 0 rows and is rejected.
    """  # noqa: E501
    max_ai = ANONYMOUS_LIMITS["ai_extractions"] if is_anonymous else REGISTERED_LIMITS["ai_extractions"]
    now = datetime.now(timezone.utc)

    result = db.execute(
        update(UsageLimit)
        .where(
            UsageLimit.user_id == user_id,
            UsageLimit.is_anonymous == is_anonymous,
            UsageLimit.ai_extraction_count < max_ai,
        )
        .values(ai_extraction_count=UsageLimit.ai_extraction_count + 1, last_activity=now)
    )
    if result.rowcount == 0:
        usage = db.query(UsageLimit).filter(
            UsageLimit.user_id == user_id,
            UsageLimit.is_anonymous == is_anonymous,
        ).first()
        if usage is not None:
            # Row exists but already at/over the limit.
            return (False, usage.ai_extraction_count, max_ai)
        # No row yet: create one atomically.
        usage = UsageLimit(
            user_id=user_id,
            is_anonymous=is_anonymous,
            ai_extraction_count=1,
            total_upload_size_bytes=0,
            last_activity=now,
        )
        db.add(usage)
        try:
            if commit:
                db.commit()
            else:
                db.flush()
        except IntegrityError:
            # Another request created the row first; retry the increment.
            db.rollback()
            db.execute(
                update(UsageLimit)
                .where(
                    UsageLimit.user_id == user_id,
                    UsageLimit.is_anonymous == is_anonymous,
                    UsageLimit.ai_extraction_count < max_ai,
                )
                .values(ai_extraction_count=UsageLimit.ai_extraction_count + 1, last_activity=now)
            )
            if commit:
                db.commit()
            else:
                db.flush()
        usage = db.query(UsageLimit).filter(
            UsageLimit.user_id == user_id,
            UsageLimit.is_anonymous == is_anonymous,
        ).first()
        return (True, usage.ai_extraction_count if usage else 1, max_ai)

    if commit:
        db.commit()
    else:
        db.flush()
    usage = db.query(UsageLimit).filter(
        UsageLimit.user_id == user_id,
        UsageLimit.is_anonymous == is_anonymous,
    ).first()
    return (True, usage.ai_extraction_count, max_ai)


def check_and_record_storage_usage(
    db: Session, user_id: str, size_bytes: int, is_anonymous: bool, commit: bool = True
) -> tuple[bool, int, int, int]:
    """
    Check if storage usage is allowed and record it.
    Returns (allowed, current_bytes, limit_bytes, remaining_bytes).

    `commit=False` defers the commit to the caller's transaction (used so a
    failed request does not persist an upload it never completed).

    The increment is performed as a single conditional UPDATE
    (current + size <= limit) so concurrent uploads cannot both read
    "under limit" and both pass.
    """  # noqa: E501
    max_storage = ANON_STORAGE_BYTES if is_anonymous else REGISTERED_STORAGE_BYTES
    now = datetime.now(timezone.utc)

    result = db.execute(
        update(UsageLimit)
        .where(
            UsageLimit.user_id == user_id,
            UsageLimit.is_anonymous == is_anonymous,
            UsageLimit.total_upload_size_bytes + size_bytes <= max_storage,
        )
        .values(total_upload_size_bytes=UsageLimit.total_upload_size_bytes + size_bytes, last_activity=now)
    )
    if result.rowcount == 0:
        usage = db.query(UsageLimit).filter(
            UsageLimit.user_id == user_id,
            UsageLimit.is_anonymous == is_anonymous,
        ).first()
        if usage is not None:
            new_total = usage.total_upload_size_bytes + size_bytes
            if new_total > max_storage:
                return (False, usage.total_upload_size_bytes, max_storage, max_storage - usage.total_upload_size_bytes)
            # Limit changed (e.g. tier upgrade) since the row was read; accept it.
            usage.total_upload_size_bytes = new_total
            usage.last_activity = now
            if commit:
                db.commit()
            else:
                db.flush()
            return (True, new_total, max_storage, max_storage - new_total)
        # No row yet: create one atomically (reject a single oversized first upload).
        if size_bytes > max_storage:
            return (False, 0, max_storage, max_storage)
        usage = UsageLimit(
            user_id=user_id,
            is_anonymous=is_anonymous,
            ai_extraction_count=0,
            total_upload_size_bytes=size_bytes,
            last_activity=now,
        )
        db.add(usage)
        try:
            if commit:
                db.commit()
            else:
                db.flush()
        except IntegrityError:
            db.rollback()
            db.execute(
                update(UsageLimit)
                .where(
                    UsageLimit.user_id == user_id,
                    UsageLimit.is_anonymous == is_anonymous,
                    UsageLimit.total_upload_size_bytes + size_bytes <= max_storage,
                )
                .values(total_upload_size_bytes=UsageLimit.total_upload_size_bytes + size_bytes, last_activity=now)
            )
            if commit:
                db.commit()
            else:
                db.flush()
        usage = db.query(UsageLimit).filter(
            UsageLimit.user_id == user_id,
            UsageLimit.is_anonymous == is_anonymous,
        ).first()
        new_total = usage.total_upload_size_bytes if usage else size_bytes
        return (True, new_total, max_storage, max_storage - new_total)

    if commit:
        db.commit()
    else:
        db.flush()
    usage = db.query(UsageLimit).filter(
        UsageLimit.user_id == user_id,
        UsageLimit.is_anonymous == is_anonymous,
    ).first()
    new_total = usage.total_upload_size_bytes if usage else size_bytes
    return (True, new_total, max_storage, max_storage - new_total)


def get_usage_record(db: Session, user_id: str, is_anonymous: bool) -> Optional[UsageLimit]:
    """Get the usage limit record for a user."""
    return db.query(UsageLimit).filter(
        UsageLimit.user_id == user_id,
        UsageLimit.is_anonymous == is_anonymous
    ).first()
