"""A3 tests: notifications API (list / mark-read / read-all / dismiss)."""

import uuid

import pytest

from app.db.models import Notification
from tests.seed_data import TEST_USER_ID

OTHER_USER_ID = "other-user-notifs"


def _notify(db, user_id, type_="import_job_done", read=False, created_at=None, job_id=None):
    from datetime import datetime, timezone

    row = Notification(
        id=uuid.uuid4().hex,
        user_id=user_id,
        job_id=job_id or uuid.uuid4().hex,
        type=type_,
        payload={"job_id": job_id or uuid.uuid4().hex, "filename": "report.pdf"},
        read_at=datetime.now(timezone.utc) if read else None,
        created_at=created_at or datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    return row


@pytest.mark.asyncio
async def test_list_empty(client, db_session):
    resp = await client.get("/api/notifications")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"unread_count": 0, "items": []}


@pytest.mark.asyncio
async def test_list_unread_count_and_order(client, db_session):
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    older = _notify(db_session, TEST_USER_ID, created_at=now - timedelta(minutes=5))
    newer_read = _notify(db_session, TEST_USER_ID, read=True, created_at=now)
    resp = await client.get("/api/notifications")
    body = resp.json()
    assert body["unread_count"] == 1
    assert [i["id"] for i in body["items"]] == [newer_read.id, older.id]
    assert body["items"][1]["read_at"] is None
    assert body["items"][0]["read_at"] is not None


@pytest.mark.asyncio
async def test_mark_read_idempotent(client, db_session):
    row = _notify(db_session, TEST_USER_ID)
    first = await client.post(f"/api/notifications/{row.id}/read")
    assert first.status_code == 200
    read_at = first.json()["read_at"]
    assert read_at is not None
    second = await client.post(f"/api/notifications/{row.id}/read")
    assert second.status_code == 200
    assert second.json()["read_at"] == read_at  # idempotent
    db_session.rollback()
    assert db_session.query(Notification).filter(Notification.id == row.id).one().read_at is not None


@pytest.mark.asyncio
async def test_tenant_scoping(client, db_session):
    foreign = _notify(db_session, OTHER_USER_ID)
    own = _notify(db_session, TEST_USER_ID)
    # Foreign id -> tenant-scoped 404, no info leak.
    assert (await client.post(f"/api/notifications/{foreign.id}/read")).status_code == 404
    assert (await client.delete(f"/api/notifications/{foreign.id}")).status_code == 404
    # List shows only own rows.
    resp = await client.get("/api/notifications")
    assert {i["id"] for i in resp.json()["items"]} == {own.id}
    # Foreign rows untouched.
    db_session.rollback()
    assert db_session.query(Notification).filter(Notification.id == foreign.id).one() is not None


@pytest.mark.asyncio
async def test_read_all(client, db_session):
    _notify(db_session, TEST_USER_ID)
    _notify(db_session, TEST_USER_ID)
    _notify(db_session, TEST_USER_ID, read=True)
    resp = await client.post("/api/notifications/read-all")
    assert resp.status_code == 200
    db_session.rollback()
    unread = (
        db_session.query(Notification)
        .filter(Notification.user_id == TEST_USER_ID, Notification.read_at.is_(None))
        .count()
    )
    assert unread == 0
    listing = await client.get("/api/notifications")
    assert listing.json()["unread_count"] == 0


@pytest.mark.asyncio
async def test_dismiss_deletes_row_only(client, db_session):
    row = _notify(db_session, TEST_USER_ID)
    resp = await client.delete(f"/api/notifications/{row.id}")
    assert resp.status_code == 200
    db_session.rollback()
    assert db_session.query(Notification).filter(Notification.id == row.id).count() == 0
