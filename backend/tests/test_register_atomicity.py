"""
Regression tests for ISSUES.md #39 (register flow atomicity):

- The registered-usage guard in ``copy_anonymous_data`` used Python ``not``
  on an instrumented attribute (``WHERE 0 = 1``), so a retried migration hit
  the usage PK with an IntegrityError.
- Account creation committed before the anonymous-data copy ran, so a
  migration failure left a half-registered account behind.
- The email check-then-insert race surfaced as an unhandled IntegrityError
  (500) instead of a 409.
"""
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.api.auth as auth_api
from app.api.anon_session import sign_anon_id
from app.api.auth import router as auth_router
from app.db.models import MedicalEntry, Patient, UsageLimit
from app.db.session import Base, get_db
from config import ANONYMOUS_COOKIE_NAME
from tests.seed_data import TEST_ANON_ID, seed_test_db


@pytest.fixture(scope="function")
def reg_db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    seed_test_db(session)

    yield session

    session.close()
    Base.metadata.drop_all(bind=engine)


@pytest_asyncio.fixture
async def reg_client(reg_db_session):
    app = FastAPI()
    app.include_router(auth_router)

    async def override_get_db():
        yield reg_db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _register_body(email: str, migrate: bool = True) -> dict:
    return {
        "name": "Newcomer",
        "email": email,
        "password": "password123",
        "dob": "1990-01-01",
        "gender": "Other",
        "migrate_data": migrate,
    }


class TestRegisterAtomicity:
    async def test_migration_failure_leaves_no_account(
        self, reg_client, reg_db_session, monkeypatch
    ):
        """If the anon-data copy blows up, the account creation must roll
        back with it (previously create_user committed first)."""

        def boom(db, anon_id, new_user_id, commit=True):
            raise RuntimeError("migration failed")

        monkeypatch.setattr(auth_api, "copy_anonymous_data", boom)
        # The bare test app re-raises instead of converting to a 500; the
        # assertion that matters is what's left in the DB afterwards.
        with pytest.raises(RuntimeError, match="migration failed"):
            await reg_client.post(
                "/api/auth/register",
                json=_register_body("doomed@example.com"),
                headers={"Cookie": f"{ANONYMOUS_COOKIE_NAME}={sign_anon_id(TEST_ANON_ID)}"},
            )
        # Prod's get_db closes the request session (→ rollback). The shared
        # StaticPool connection would otherwise still see the uncommitted
        # INSERT, so roll it back here to mirror the teardown. Under the old
        # code (create_user committed first) the account survived this.
        reg_db_session.rollback()
        assert (
            reg_db_session.query(Patient)
            .filter(Patient.email == "doomed@example.com")
            .first()
            is None
        )

    async def test_duplicate_email_race_maps_to_409(
        self, reg_client, reg_db_session, monkeypatch
    ):
        """Concurrent registration (check-then-insert TOCTOU): the INSERT
        fails with IntegrityError — surface 409, not a 500."""
        reg_db_session.add(Patient(
            id="racer-1",
            email="taken@example.com",
            hashed_password="hashed",
            name="Already Here",
            dob="1990-01-01",
            gender="Other",
            external_id="HP-RACE-0001",
        ))
        reg_db_session.commit()

        # Simulate the race: the pre-check misses the row that exists by the
        # time the INSERT runs.
        monkeypatch.setattr(auth_api, "get_user_by_email", lambda db, email: None)
        resp = await reg_client.post(
            "/api/auth/register", json=_register_body("taken@example.com")
        )
        assert resp.status_code == 409
        assert (
            reg_db_session.query(Patient)
            .filter(Patient.email == "taken@example.com")
            .count()
            == 1
        )


class TestRegisteredUsageGuard:
    def test_second_migration_does_not_hit_usage_pk(self, reg_db_session):
        """The registered-usage guard used Python ``not`` on an instrumented
        attribute → ``WHERE 0 = 1`` → the guard never matched and a retried
        migration hit the usage_limit PK with an IntegrityError."""
        from app.services.data_migration import copy_anonymous_data

        reg_db_session.add(MedicalEntry(
            id="anon-entry-1",
            patient_id=TEST_ANON_ID,
            type="blood_test",
            date=datetime(2026, 1, 1, tzinfo=timezone.utc),
            title="Anon Entry",
            clinic="Clinic",
        ))
        reg_db_session.add(UsageLimit(
            user_id=TEST_ANON_ID,
            is_anonymous=True,
            ai_extraction_count=3,
            total_upload_size_bytes=1234,
        ))
        reg_db_session.commit()

        target = "new-user-1"
        copy_anonymous_data(reg_db_session, TEST_ANON_ID, target)
        # Retry (same target user): the guard must now find the registered
        # usage row created by the first call and skip the insert.
        copy_anonymous_data(reg_db_session, TEST_ANON_ID, target)

        rows = (
            reg_db_session.query(UsageLimit)
            .filter(UsageLimit.user_id == target)
            .all()
        )
        assert len(rows) == 1
        assert rows[0].ai_extraction_count == 3

    async def test_usage_inherited_on_register(
        self, reg_client, reg_db_session
    ):
        reg_db_session.add(UsageLimit(
            user_id=TEST_ANON_ID,
            is_anonymous=True,
            ai_extraction_count=2,
            total_upload_size_bytes=999,
        ))
        reg_db_session.commit()

        resp = await reg_client.post(
            "/api/auth/register",
            json=_register_body("inheritor@example.com"),
            headers={"Cookie": f"{ANONYMOUS_COOKIE_NAME}={sign_anon_id(TEST_ANON_ID)}"},
        )
        assert resp.status_code == 201
        new_user_id = resp.json()["id"]
        usage = (
            reg_db_session.query(UsageLimit)
            .filter(UsageLimit.user_id == new_user_id, ~UsageLimit.is_anonymous)
            .first()
        )
        assert usage is not None
        assert usage.ai_extraction_count == 2
        assert usage.total_upload_size_bytes == 999
