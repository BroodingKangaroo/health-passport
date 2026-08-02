"""
API endpoints for usage limits.
"""

from typing import Optional, Tuple
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.auth import get_current_user_or_anon
from app.db.session import get_db
from app.schemas import UsageLimitsResponse
from app.services.usage_limits import get_limits

router = APIRouter(prefix="/api/usage", tags=["usage"])


@router.get("/limits", response_model=UsageLimitsResponse)
async def get_usage_limits(
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[object], str, bool] = Depends(get_current_user_or_anon)
):
    """Get current usage and limits for the current user (authenticated or anonymous)."""
    user, user_id, is_anonymous = user_data
    return get_limits(db, user_id, is_anonymous)
