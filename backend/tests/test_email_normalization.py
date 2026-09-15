"""Email normalization & case-insensitive ownership.

pydantic's ``EmailStr`` lowercases only the DOMAIN, so before this
``Bob@example.com`` and ``bob@example.com`` were two accounts on one mailbox:
registration accepted the duplicate (SQLite's UNIQUE index is case-sensitive),
login only matched the exact spelling, and the change-email conflict check
missed case variants. Addresses are now trimmed + lowercased on every WRITE
path, every lookup normalizes its input, and ``migrate_normalize_emails``
rewrites legacy rows while refusing to guess at genuine collisions.
"""

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import auth as auth_api
from app.auth import get_user_by_email, normalize_email
from app.db.models import EmailChangeToken, Patient
from app.db.session import Base, get_db, migrate_normalize_emails
from tests.seed_data import (
    TEST_USER_EMAIL,
    TEST_USER_ID,
    TEST_USER_PASSWORD,
    seed_test_db,
)

OTHER_USER_ID = "otheruser"
OTHER_USER_EMAIL = "other@example.com"


@pytest.fixture(scope="function")
def norm_session():
    """StaticPool in-memory DB (``register``/``login`` run in the threadpool)."""
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


@pytest.fixture(autouse=True)
def _clear_throttle():
    auth_api._throttle_windows.clear()
    yield


@pytest_asyncio.fixture
async def norm_client(norm_session, monkeypatch):
    sent = {"confirmation": [], "squatted": []}
    monkeypatch.setattr(
        auth_api, "send_email_change_email",
        lambda email, url: sent["confirmation"].append((email, url)),
    )
    monkeypatch.setattr(
        auth_api, "send_email_change_squatted_notice",
        lambda email: sent["squatted"].append(email),
    )
    monkeypatch.setattr(auth_api, "send_email_change_notice", lambda *a: None)

    app = FastAPI()
    app.include_router(auth_api.router)

    async def override_get_db():
        yield norm_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, sent


def _add_other_user(db) -> None:
    db.add(Patient(
        id=OTHER_USER_ID,
        email=OTHER_USER_EMAIL,
        hashed_password="x",
        name="Other User",
        dob="1980-01-01",
        gender="Other",
        external_id="HP-TEST-0002",
    ))
    db.commit()


async def _login(client, email: str, password: str = TEST_USER_PASSWORD):
    return await client.post(
        "/api/auth/login", data={"username": email, "password": password}
    )


class TestNormalizeEmailUnit:
    def test_trims_and_lowercases(self):
        assert normalize_email("  Bob@Example.COM ") == "bob@example.com"

    def test_none_becomes_empty(self):
        assert normalize_email(None) == ""


class TestLookupIsCaseInsensitive:
    async def test_lookup_matches_any_casing(self, norm_session):
        assert get_user_by_email(norm_session, "TEST@Example.com").id == TEST_USER_ID
        assert get_user_by_email(norm_session, "  test@example.com  ").id == TEST_USER_ID
        assert get_user_by_email(norm_session, "") is None
        assert get_user_by_email(norm_session, "nobody@example.com") is None


class TestRegistration:
    async def test_case_variant_duplicate_is_rejected(self, norm_client):
        client, _ = norm_client
        resp = await client.post(
            "/api/auth/register",
            json={
                "email": "TEST@EXAMPLE.com",
                "password": "anotherpass123",
                "name": "Duplicate",
                "dob": "1990-01-01",
                "gender": "Other",
            },
        )
        assert resp.status_code == 400
        assert "already registered" in resp.json()["detail"].lower()

    async def test_stored_address_is_normalized(self, norm_client, norm_session):
        client, _ = norm_client
        resp = await client.post(
            "/api/auth/register",
            json={
                "email": "  NewUser@Example.COM ",
                "password": "anotherpass123",
                "name": "New User",
                "dob": "1990-01-01",
                "gender": "Other",
            },
        )
        assert resp.status_code == 201
        assert resp.json()["email"] == "newuser@example.com"
        assert get_user_by_email(norm_session, "NEWUSER@example.com") is not None


class TestLogin:
    async def test_login_succeeds_with_different_casing(self, norm_client):
        client, _ = norm_client
        for spelling in ("TEST@example.com", "test@EXAMPLE.com", " Test@Example.com "):
            resp = await _login(client, spelling)
            assert resp.status_code == 200, spelling
            assert resp.json()["access_token"]

    async def test_wrong_password_still_fails(self, norm_client):
        client, _ = norm_client
        resp = await _login(client, "TEST@example.com", password="wrong-password")
        assert resp.status_code == 401


class TestChangeEmailOwnership:
    async def test_case_variant_of_another_account_is_uniform_not_409(
        self, norm_client, norm_session
    ):
        """Anti-enumeration (audit item: change-email oracle): the request must
        look identical whether the address is free or taken, and the squatted
        address — not the caller — gets told."""
        client, sent = norm_client
        _add_other_user(norm_session)
        token = (await _login(client, TEST_USER_EMAIL)).json()["access_token"]

        resp = await client.post(
            "/api/auth/change-email",
            json={
                "current_password": TEST_USER_PASSWORD,
                "new_email": "Other@Example.COM",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

        assert resp.status_code == 200
        # The uniform message names the NORMALIZED form (that is the address
        # the server would use); the caller learns nothing about ownership.
        assert "other@example.com" in resp.json()["message"]
        # No pending change: only the address owner is warned.
        assert norm_session.query(EmailChangeToken).count() == 0
        assert sent["confirmation"] == []
        assert sent["squatted"] == ["other@example.com"]
        # Neither account moved.
        assert get_user_by_email(norm_session, OTHER_USER_EMAIL).id == OTHER_USER_ID
        assert get_user_by_email(norm_session, TEST_USER_EMAIL).id == TEST_USER_ID

    async def test_free_address_still_stages_a_change(self, norm_client, norm_session):
        client, sent = norm_client
        token = (await _login(client, TEST_USER_EMAIL)).json()["access_token"]

        resp = await client.post(
            "/api/auth/change-email",
            json={
                "current_password": TEST_USER_PASSWORD,
                "new_email": "  Mixed@NewPlace.COM ",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

        assert resp.status_code == 200
        assert norm_session.query(EmailChangeToken).one().new_email == "mixed@newplace.com"
        assert sent["squatted"] == []
        assert sent["confirmation"][0][0] == "mixed@newplace.com"

    async def test_own_address_in_another_casing_is_still_unchanged(self, norm_client):
        client, _ = norm_client
        token = (await _login(client, TEST_USER_EMAIL)).json()["access_token"]
        resp = await client.post(
            "/api/auth/change-email",
            json={
                "current_password": TEST_USER_PASSWORD,
                "new_email": TEST_USER_EMAIL.upper(),
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 400
        assert "already your email" in resp.json()["detail"].lower()


class TestMigration:
    @staticmethod
    def _legacy_engine():
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(bind=engine)
        return engine

    @staticmethod
    def _insert(engine, rows) -> None:
        session = sessionmaker(bind=engine)()
        try:
            for pid, email in rows:
                session.add(Patient(
                    id=pid,
                    email=email,
                    hashed_password="x",
                    name=pid,
                    dob="",
                    gender="",
                    external_id=f"HP-{pid}",
                ))
            session.commit()
        finally:
            session.close()

    def _emails(self, engine) -> dict[str, str]:
        with engine.begin() as conn:
            return {r.id: r.email for r in conn.execute(text("SELECT id, email FROM patients"))}

    def test_rewrites_legacy_rows_and_is_idempotent(self):
        engine = self._legacy_engine()
        self._insert(engine, [("u1", "Bob@Example.COM"), ("u2", "  spaced@x.io ")])

        migrate_normalize_emails(engine)
        assert self._emails(engine) == {"u1": "bob@example.com", "u2": "spaced@x.io"}

        # Running again changes nothing (init_db calls it on every boot).
        migrate_normalize_emails(engine)
        assert self._emails(engine) == {"u1": "bob@example.com", "u2": "spaced@x.io"}

    def test_case_colliding_rows_are_reported_and_left_alone(self, caplog):
        """Two accounts differing only by case share one mailbox — a product
        decision, never a silent rewrite (lowercasing both would crash the
        UNIQUE index)."""
        import logging

        engine = self._legacy_engine()
        self._insert(engine, [("u1", "Bob@example.com"), ("u2", "bob@example.com"), ("u3", "solo@X.io")])

        with caplog.at_level(logging.ERROR, logger="app.db.session"):
            migrate_normalize_emails(engine)

        # The pair is untouched; the unrelated row is still normalized.
        assert self._emails(engine) == {
            "u1": "Bob@example.com",
            "u2": "bob@example.com",
            "u3": "solo@x.io",
        }
        assert "bob@example.com" in caplog.text
        assert "share this mailbox" in caplog.text
