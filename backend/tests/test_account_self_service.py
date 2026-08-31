"""Account self-service (ISSUES.md F2): change-password + delete-account.

Covers the change-password flow (happy / wrong current / too short / anon
401, localized errors) and account deletion for both principals — the
cascade order, the no-other-reference file-unlink guard, local-definition /
token / usage-row / Patient removal, and localization.
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Request, Response
from httpx import ASGITransport, AsyncClient

from app.api.auth import (
    get_current_user,
    get_current_user_or_anon,
)
from app.api.auth import (
    router as auth_router,
)
from app.auth import authenticate_user
from app.db.models import (
    Attachment,
    BiomarkerDefinition,
    BiomarkerReading,
    MedicalEntry,
    PasswordResetToken,
    Patient,
    UsageLimit,
    VisitData,
)
from app.db.session import get_db
from app.i18n import LocaleMiddleware
from tests.seed_data import TEST_ANON_ID, TEST_USER_ID


def _make_client(db_session, *, override_current_user=True):
    """Auth-router client; by default `get_current_user` resolves to the
    seeded test user (no token needed), `get_current_user_or_anon` too."""
    app = FastAPI()
    app.include_router(auth_router)
    app.add_middleware(LocaleMiddleware)

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        from app.db.models import Patient

        return db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()

    async def override_principal(request: Request, response: Response):
        from app.db.models import Patient

        user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
        return (user, TEST_USER_ID, False)

    app.dependency_overrides[get_db] = override_get_db
    if override_current_user:
        app.dependency_overrides[get_current_user] = override_get_current_user
        app.dependency_overrides[get_current_user_or_anon] = override_principal

    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


def _make_upload_file(tmp_path, monkeypatch, contents: bytes = b"pdf-bytes") -> tuple[str, str]:
    """Create a real file in a tmp uploads dir (patched into the cleanup
    service); returns (file_path, full_path)."""
    monkeypatch.setattr("app.services.upload_cleanup.UPLOAD_DIR", str(tmp_path))
    name = f"{uuid.uuid4().hex}.pdf"
    full_path = os.path.join(str(tmp_path), name)
    with open(full_path, "wb") as f:
        f.write(contents)
    return f"/static/uploads/{name}", full_path


def _add_local_def(db_session, defn_id: str, user_id: str):
    db_session.add(BiomarkerDefinition(
        id=defn_id,
        names={"en": "Local Marker"},
        category="Custom",
        reference={"kind": "interval", "low": 0.0, "high": 10.0},
        unit="x",
        scope="local",
        user_id=user_id,
        reference_source="local",
    ))


class TestChangePassword:
    async def test_change_password_success(self, db_session):
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/change-password",
                json={"current_password": "testpassword123", "new_password": "newpassword456"},
            )
        assert resp.status_code == 200
        assert resp.json()["message"] == "Password changed."
        # The new password authenticates; the old one no longer does.
        db_session.expire_all()
        assert authenticate_user(db_session, "test@example.com", "newpassword456") is not None
        assert authenticate_user(db_session, "test@example.com", "testpassword123") is None

    async def test_wrong_current_password_400(self, db_session):
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/change-password",
                json={"current_password": "wrong-password", "new_password": "newpassword456"},
            )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Current password is incorrect"

    async def test_new_password_too_short_400(self, db_session):
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/change-password",
                json={"current_password": "testpassword123", "new_password": "short"},
            )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Password must be at least 8 characters"

    async def test_anonymous_gets_401(self, db_session):
        # No get_current_user override and no token → the real 401 path.
        async with _make_client(db_session, override_current_user=False) as ac:
            resp = await ac.post(
                "/api/auth/change-password",
                json={"current_password": "x", "new_password": "newpassword456"},
            )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Not authenticated"

    async def test_error_localized_ru(self, db_session):
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/change-password",
                json={"current_password": "wrong-password", "new_password": "newpassword456"},
                headers={"Accept-Language": "ru"},
            )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Текущий пароль указан неверно"


class TestDeleteAccountRegistered:
    async def test_full_cascade(self, db_session):
        # Give the seeded user a local def, a reset token and a usage row.
        _add_local_def(db_session, "local-del-a", TEST_USER_ID)
        db_session.add(PasswordResetToken(
            id="rt-1",
            patient_id=TEST_USER_ID,
            token_hash="hash",
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=30),
        ))
        db_session.add(UsageLimit(
            user_id=TEST_USER_ID, is_anonymous=False,
            ai_extraction_count=3, total_upload_size_bytes=1024,
        ))
        db_session.commit()

        async with _make_client(db_session) as ac:
            resp = await ac.delete("/api/auth/account")
        assert resp.status_code == 200
        body = resp.json()
        assert body["message"] == "Your data has been permanently deleted."
        assert body["deleted_entries"] == 13  # 9 blood + 3 visits + 1 procedure

        db_session.expire_all()
        assert db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first() is None
        assert db_session.query(MedicalEntry).count() == 0
        assert db_session.query(BiomarkerReading).count() == 0
        assert db_session.query(VisitData).count() == 0
        assert db_session.query(Attachment).count() == 0
        # Local defs removed; globals survive (they are shared, not the user's).
        assert db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.scope == "local").count() == 0
        assert db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "wbc").count() == 1
        assert db_session.query(PasswordResetToken).count() == 0
        assert db_session.query(UsageLimit).count() == 0
        # Login after deletion finds nothing.
        assert authenticate_user(db_session, "test@example.com", "testpassword123") is None

    async def test_unlinks_owned_files(self, db_session, tmp_path, monkeypatch):
        file_path, full_path = _make_upload_file(tmp_path, monkeypatch)
        entry = MedicalEntry(
            id="file-entry", patient_id=TEST_USER_ID, type="blood_test",
            date=datetime(2024, 5, 1, tzinfo=timezone.utc), title="With File",
        )
        db_session.add(entry)
        db_session.flush()
        db_session.add(Attachment(
            id="att-file", entry_id="file-entry",
            name="report.pdf", type="Lab Report", size="1 KB", file_path=file_path,
        ))
        db_session.commit()

        async with _make_client(db_session) as ac:
            resp = await ac.delete("/api/auth/account")
        assert resp.status_code == 200
        assert resp.json()["freed_bytes"] == len(b"pdf-bytes")
        assert not os.path.isfile(full_path)

    async def test_shared_file_survives(self, db_session, tmp_path, monkeypatch):
        # Two principals' attachment rows point at the same file (the
        # anon→user migration shape): deleting the user's account must NOT
        # unlink a file the other principal still references.
        file_path, full_path = _make_upload_file(tmp_path, monkeypatch)
        from app.auth import create_user

        user_b = create_user(db_session, "user-b@example.com", "password123", "B", "1980-01-01", "Other")
        db_session.add(MedicalEntry(
            id="file-entry-a", patient_id=TEST_USER_ID, type="blood_test",
            date=datetime(2024, 5, 1, tzinfo=timezone.utc), title="A File",
        ))
        db_session.add(MedicalEntry(
            id="file-entry-b", patient_id=user_b.id, type="blood_test",
            date=datetime(2024, 5, 2, tzinfo=timezone.utc), title="B File",
        ))
        db_session.flush()
        for eid in ("file-entry-a", "file-entry-b"):
            db_session.add(Attachment(
                id=f"att-{eid}", entry_id=eid,
                name="shared.pdf", type="Lab Report", size="1 KB", file_path=file_path,
            ))
        db_session.commit()

        async with _make_client(db_session) as ac:
            resp = await ac.delete("/api/auth/account")
        assert resp.status_code == 200
        assert resp.json()["freed_bytes"] == 0  # still referenced by user B
        assert os.path.isfile(full_path)
        db_session.expire_all()
        assert db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == user_b.id).count() == 1


class TestDeleteAccountAnonymous:
    async def test_anon_cascade_and_cookie_clear(self, db_session):
        db_session.add(MedicalEntry(
            id="anon-del-entry", patient_id=TEST_ANON_ID, type="blood_test",
            date=datetime(2024, 6, 1, tzinfo=timezone.utc), title="Anon Panel",
        ))
        db_session.flush()
        db_session.add(BiomarkerReading(
            entry_id="anon-del-entry", biomarker_id="wbc", value=6.0,
            reference={"kind": "interval", "low": 4.0, "high": 11.0}, status="normal",
        ))
        _add_local_def(db_session, "local-del-anon", TEST_ANON_ID)
        db_session.add(UsageLimit(
            user_id=TEST_ANON_ID, is_anonymous=True,
            ai_extraction_count=2, total_upload_size_bytes=512,
        ))
        db_session.commit()

        app = FastAPI()
        app.include_router(auth_router)

        async def override_get_db():
            yield db_session

        async def override_principal(request: Request, response: Response):
            return (None, TEST_ANON_ID, True)

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_current_user_or_anon] = override_principal
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.delete("/api/auth/account")

        assert resp.status_code == 200
        assert resp.json()["message"] == "Your data has been permanently deleted."
        # The anon cookie is cleared so the next visit starts a fresh session.
        assert "healthpassport_anon_id" in resp.headers.get("set-cookie", "")

        db_session.expire_all()
        assert db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == TEST_ANON_ID).count() == 0
        assert db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.user_id == TEST_ANON_ID).count() == 0
        assert db_session.query(UsageLimit).count() == 0
        # The registered user's data is untouched.
        assert db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == TEST_USER_ID).count() == 13

    async def test_message_localized_ru(self, db_session):
        app = FastAPI()
        app.include_router(auth_router)
        app.add_middleware(LocaleMiddleware)

        async def override_get_db():
            yield db_session

        async def override_principal(request: Request, response: Response):
            return (None, TEST_ANON_ID, True)

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_current_user_or_anon] = override_principal
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.delete("/api/auth/account", headers={"Accept-Language": "ru"})
        assert resp.json()["message"] == "Ваши данные безвозвратно удалены."
