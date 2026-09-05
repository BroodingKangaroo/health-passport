"""Per-user in-app notifications (bell icon) for the batch import feature.

Emission lives in the worker / startup recovery (one row per job terminal
transition); this router only reads/dismisses them. Anonymous principals
participate like everywhere else (the bell works for anon's ≤5-doc imports).
"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import i18n
from app.api.auth import get_current_user_or_anon
from app.db.models import Notification, Patient
from app.db.session import get_db

router = APIRouter()


def _serialize(row: Notification) -> dict:
    return {
        "id": row.id,
        "job_id": row.job_id,
        "type": row.type,
        "payload": row.payload,
        "read_at": row.read_at.isoformat() if row.read_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.get("/api/notifications")
async def list_notifications(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, _is_anonymous = user_data
    rows = (
        db.query(Notification)
        .filter(Notification.user_id == user_id)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(50)
        .all()
    )
    unread_count = (
        db.query(Notification)
        .filter(Notification.user_id == user_id, Notification.read_at.is_(None))
        .count()
    )
    return {"unread_count": unread_count, "items": [_serialize(r) for r in rows]}


def _own_notification(db: Session, notification_id: str, user_id: str) -> Notification:
    row = (
        db.query(Notification)
        .filter(Notification.id == notification_id, Notification.user_id == user_id)
        .first()
    )
    if row is None:
        # Foreign / unknown id — tenant-scoped 404, no info leak.
        raise HTTPException(status_code=404, detail=i18n.tr("notifications.not_found"))
    return row


@router.post("/api/notifications/{notification_id}/read")
async def mark_notification_read(
    notification_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, _is_anonymous = user_data
    row = _own_notification(db, notification_id, user_id)
    if row.read_at is None:
        row.read_at = datetime.now(timezone.utc)
        db.commit()
    return _serialize(row)


@router.post("/api/notifications/read-all")
async def mark_all_notifications_read(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, _is_anonymous = user_data
    now = datetime.now(timezone.utc)
    db.query(Notification).filter(
        Notification.user_id == user_id, Notification.read_at.is_(None)
    ).update({"read_at": now}, synchronize_session=False)
    db.commit()
    return {"marked": True}


@router.delete("/api/notifications/{notification_id}")
async def dismiss_notification(
    notification_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, _is_anonymous = user_data
    row = _own_notification(db, notification_id, user_id)
    # Dismissing does NOT delete the staged job — it expires via GC on its own.
    db.delete(row)
    db.commit()
    return {"dismissed": True}
