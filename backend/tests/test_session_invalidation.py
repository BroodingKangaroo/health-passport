"""Session invalidation (roadmap 0.4): changing the credential or the login
identity must retire every token already issued.

Before this, access tokens were 7-day JWTs with nothing able to revoke one, so
the email-change notice's "reset your password immediately" advice was empty:
an attacker holding a stolen token kept a session no matter what the victim
did. Every JWT now carries the account's monotonic ``token_version`` (the
``tv`` claim) and ``get_current_user`` rejects a token whose claim is behind
the row.

Each of the three bump paths is exercised end to end — log in, perform the
action with that very token, then assert the OLD token 401s while a fresh login
works.
"""

from urllib.parse import urlparse

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import auth as auth_api
from app.api.usage_limits import router as usage_limits_router
from app.auth import decode_token
from app.db.models import Patient
from app.db.session import Base, get_db
from app.i18n import LocaleMiddleware
from tests.seed_data import (
    TEST_USER_EMAIL,
    TEST_USER_ID,
    TEST_USER_PASSWORD,
    seed_test_db,
)

NEW_EMAIL = "moved@example.com"
NEW_PASSWORD = "brandnewpass456"


@pytest.fixture(scope="function")
def invalidation_session():
    """StaticPool in-memory DB: ``login`` is a sync endpoint that Starlette runs
    in its threadpool, so a plain SingletonThreadPool engine (the default for
    ``sqlite:///:memory:``) would hand that thread an empty database."""
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
    """The auth throttle is module-global state; keep tests independent."""
    auth_api._throttle_windows.clear()
    yield


@pytest_asyncio.fixture
async def session_client(invalidation_session, monkeypatch):
    """Auth + anon-capable endpoints with REAL principal dependencies."""
    sent = {"reset": [], "confirm": []}
    monkeypatch.setattr(
        auth_api, "send_reset_email",
        lambda email, url: sent["reset"].append((email, url)),
    )
    monkeypatch.setattr(
        auth_api, "send_email_change_email",
        lambda email, url: sent["confirm"].append((email, url)),
    )
    monkeypatch.setattr(auth_api, "send_email_change_notice", lambda *a: None)
    monkeypatch.setattr(auth_api, "send_email_change_squatted_notice", lambda *a: None)

    app = FastAPI()
    app.include_router(auth_api.router)
    app.include_router(usage_limits_router)
    app.add_middleware(LocaleMiddleware)

    async def override_get_db():
        yield invalidation_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, sent


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _login(client, email: str = TEST_USER_EMAIL, password: str = TEST_USER_PASSWORD) -> str:
    resp = await client.post(
        "/api/auth/login", data={"username": email, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _token_from_url(url: str) -> str:
    qs = urlparse(url).query
    return dict(pair.split("=", 1) for pair in qs.split("&"))["token"]


def _version(db, patient_id: str = TEST_USER_ID) -> int:
    db.expire_all()
    return db.query(Patient).filter(Patient.id == patient_id).one().token_version


class TestTokenVersionClaim:
    async def test_login_embeds_the_current_version(self, session_client):
        client, _ = session_client
        token = await _login(client)
        assert decode_token(token)["tv"] == 0

    async def test_superseded_token_is_401_not_anonymous(
        self, session_client, invalidation_session
    ):
        """The anon fallback is for absent/invalid credentials — a token that
        WAS valid must force re-auth, else the page silently renders another
        (empty) identity's data."""
        client, _ = session_client
        token = await _login(client)

        user = invalidation_session.query(Patient).filter(Patient.id == TEST_USER_ID).one()
        user.token_version = 1
        invalidation_session.commit()

        resp = await client.get("/api/usage/limits", headers=_bearer(token))
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Your session has ended. Please sign in again."

    async def test_superseded_token_is_localized(
        self, session_client, invalidation_session
    ):
        client, _ = session_client
        token = await _login(client)
        user = invalidation_session.query(Patient).filter(Patient.id == TEST_USER_ID).one()
        user.token_version = 1
        invalidation_session.commit()

        resp = await client.get(
            "/api/auth/me",
            headers={**_bearer(token), "Accept-Language": "ru"},
        )
        assert resp.status_code == 401
        assert "Сессия" in resp.json()["detail"]

    async def test_tokens_without_the_claim_read_as_version_zero(self, session_client):
        """A token minted before the column existed (no ``tv``) must not log
        every user out on deploy — it matches the column default 0."""
        from app.auth import create_access_token

        client, _ = session_client
        legacy = create_access_token(data={"sub": TEST_USER_ID, "email": TEST_USER_EMAIL})
        resp = await client.get("/api/auth/me", headers=_bearer(legacy))
        assert resp.status_code == 200


class TestPasswordChangeInvalidatesSessions:
    async def test_old_token_dies_new_login_works(
        self, session_client, invalidation_session
    ):
        client, _ = session_client
        token = await _login(client)
        assert (await client.get("/api/auth/me", headers=_bearer(token))).status_code == 200

        resp = await client.post(
            "/api/auth/change-password",
            json={"current_password": TEST_USER_PASSWORD, "new_password": NEW_PASSWORD},
            headers=_bearer(token),
        )
        assert resp.status_code == 200
        assert _version(invalidation_session) == 1

        # The token that made the change is dead too — "log out everywhere".
        assert (await client.get("/api/auth/me", headers=_bearer(token))).status_code == 401

        # …and the new password logs in with a token carrying the new version.
        fresh = await _login(client, password=NEW_PASSWORD)
        assert decode_token(fresh)["tv"] == 1
        assert (await client.get("/api/auth/me", headers=_bearer(fresh))).status_code == 200


class TestPasswordResetInvalidatesSessions:
    async def test_old_token_dies_new_login_works(self, session_client, invalidation_session):
        client, sent = session_client
        token = await _login(client)

        resp = await client.post("/api/auth/forgot-password", json={"email": TEST_USER_EMAIL})
        assert resp.status_code == 200
        raw = _token_from_url(sent["reset"][-1][1])

        resp = await client.post(
            "/api/auth/reset-password",
            json={"token": raw, "new_password": NEW_PASSWORD},
        )
        assert resp.status_code == 200
        assert _version(invalidation_session) == 1

        assert (await client.get("/api/auth/me", headers=_bearer(token))).status_code == 401
        fresh = await _login(client, password=NEW_PASSWORD)
        assert decode_token(fresh)["tv"] == 1
        assert (await client.get("/api/auth/me", headers=_bearer(fresh))).status_code == 200


class TestEmailChangeInvalidatesSessions:
    async def test_old_token_dies_and_the_new_address_logs_in(
        self, session_client, invalidation_session
    ):
        client, sent = session_client
        token = await _login(client)

        resp = await client.post(
            "/api/auth/change-email",
            json={"current_password": TEST_USER_PASSWORD, "new_email": NEW_EMAIL},
            headers=_bearer(token),
        )
        assert resp.status_code == 200
        raw = _token_from_url(sent["confirm"][-1][1])

        resp = await client.post("/api/auth/confirm-email-change", json={"token": raw})
        assert resp.status_code == 200
        assert _version(invalidation_session) == 1

        # A session issued under the previous address is gone; the notice
        # recommends /forgot-password precisely because this is now true.
        assert (await client.get("/api/auth/me", headers=_bearer(token))).status_code == 401

        fresh = await _login(client, email=NEW_EMAIL)
        assert decode_token(fresh)["tv"] == 1
        assert (await client.get("/api/auth/me", headers=_bearer(fresh))).status_code == 200

        # The old address no longer authenticates at all.
        resp = await client.post(
            "/api/auth/login",
            data={"username": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD},
        )
        assert resp.status_code == 401
