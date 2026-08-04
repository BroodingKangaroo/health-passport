"""
Tests for the password reset flow (forgot-password / reset-password).
"""

import hashlib
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import pytest
import pytest_asyncio

from app.api import auth as auth_api
from app.auth import authenticate_user
from app.db.models import PasswordResetToken, Patient
from tests.seed_data import TEST_USER_EMAIL


@pytest.fixture(autouse=True)
def _clear_throttle():
    """The throttle is module-global state; keep tests independent."""
    auth_api._reset_attempts.clear()
    yield


@pytest_asyncio.fixture
async def reset_client(db_session):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.api.auth import get_db
    from app.api.auth import router as auth_router

    app = FastAPI()
    app.include_router(auth_router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
def captured_emails(monkeypatch):
    """Capture reset emails instead of sending (SMTP is off in tests)."""
    sent = []

    def fake_send(email, reset_url):
        sent.append((email, reset_url))

    monkeypatch.setattr(auth_api, "send_reset_email", fake_send)
    return sent


def _token_from_url(reset_url: str) -> str:
    qs = urlparse(reset_url).query
    return dict(pair.split("=", 1) for pair in qs.split("&"))["token"]


class TestForgotPassword:
    async def test_sends_link_for_existing_email(self, reset_client, db_session, captured_emails):
        resp = await reset_client.post(
            "/api/auth/forgot-password", json={"email": TEST_USER_EMAIL}
        )
        assert resp.status_code == 200
        assert "reset link" in resp.json()["message"].lower()

        assert len(captured_emails) == 1
        email, reset_url = captured_emails[0]
        assert email == TEST_USER_EMAIL
        assert "/reset-password?token=" in reset_url

        # Stored row hashes the raw token; the raw value never reaches the DB.
        raw_token = _token_from_url(reset_url)
        row = db_session.query(PasswordResetToken).one()
        assert row.token_hash == hashlib.sha256(raw_token.encode()).hexdigest()
        assert row.used_at is None
        assert row.expires_at.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc)

    async def test_unknown_email_is_indistinguishable(self, reset_client, db_session, captured_emails):
        known = await reset_client.post(
            "/api/auth/forgot-password", json={"email": TEST_USER_EMAIL}
        )
        unknown = await reset_client.post(
            "/api/auth/forgot-password", json={"email": "nobody@example.com"}
        )
        assert known.status_code == unknown.status_code == 200
        assert known.json() == unknown.json()
        assert captured_emails == [(TEST_USER_EMAIL, captured_emails[0][1])]
        assert db_session.query(PasswordResetToken).count() == 1

    async def test_reset_link_ignores_request_headers(
        self, reset_client, db_session, captured_emails, monkeypatch
    ):
        """The emailed link must use the configured frontend URL, never the
        attacker-controlled Origin/Referer (a hostile Origin would rewrite the
        link to a phishing domain holding a valid token)."""
        monkeypatch.setattr(auth_api, "FRONTEND_URL", "https://app.healthpassport.example")

        resp = await reset_client.post(
            "/api/auth/forgot-password",
            json={"email": TEST_USER_EMAIL},
            headers={"Origin": "https://evil.example", "Referer": "https://evil.example/phish"},
        )
        assert resp.status_code == 200
        assert captured_emails[0][1].startswith("https://app.healthpassport.example/reset-password?token=")

    async def test_smtp_failure_still_returns_200(self, reset_client, db_session, monkeypatch, caplog):
        """A delivery failure must not 500 or reveal the account exists."""

        def boom(email, reset_url):
            raise ConnectionError("SMTP down")

        monkeypatch.setattr(auth_api, "send_reset_email", boom)
        resp = await reset_client.post(
            "/api/auth/forgot-password", json={"email": TEST_USER_EMAIL}
        )
        assert resp.status_code == 200
        assert "reset link" in resp.json()["message"].lower()

    async def test_stale_tokens_are_purged(self, reset_client, db_session):
        from app.auth import get_user_by_email

        user = get_user_by_email(db_session, TEST_USER_EMAIL)
        raw = "stale-raw-token-1"
        db_session.add(PasswordResetToken(
            id="stale-token",
            patient_id=user.id,
            token_hash=hashlib.sha256(raw.encode()).hexdigest(),
            expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
        ))
        db_session.add(PasswordResetToken(
            id="used-token",
            patient_id=user.id,
            token_hash=hashlib.sha256(b"used-raw-token-1").hexdigest(),
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            used_at=datetime.now(timezone.utc),
        ))
        db_session.commit()

        await reset_client.post("/api/auth/forgot-password", json={"email": TEST_USER_EMAIL})

        remaining = {t.id for t in db_session.query(PasswordResetToken).all()}
        assert "stale-token" not in remaining
        assert "used-token" not in remaining

    async def test_ratelimited(self, reset_client):
        email = "throttle@example.com"
        for _ in range(5):
            resp = await reset_client.post(
                "/api/auth/forgot-password", json={"email": email}
            )
            assert resp.status_code == 200
        resp = await reset_client.post(
            "/api/auth/forgot-password", json={"email": email}
        )
        assert resp.status_code == 429


class TestResetPassword:
    async def _request_token(self, reset_client, captured_emails, email=TEST_USER_EMAIL) -> str:
        await reset_client.post("/api/auth/forgot-password", json={"email": email})
        return _token_from_url(captured_emails[0][1])

    async def test_reset_changes_password(self, reset_client, db_session, captured_emails):
        token = await self._request_token(reset_client, captured_emails)

        resp = await reset_client.post(
            "/api/auth/reset-password",
            json={"token": token, "new_password": "newsecret456"},
        )
        assert resp.status_code == 200

        assert authenticate_user(db_session, TEST_USER_EMAIL, "newsecret456") is not None
        assert authenticate_user(db_session, TEST_USER_EMAIL, "testpassword123") is None

        row = db_session.query(PasswordResetToken).one()
        assert row.used_at is not None

    async def test_token_is_single_use(self, reset_client, db_session, captured_emails):
        token = await self._request_token(reset_client, captured_emails)
        payload = {"token": token, "new_password": "newsecret456"}

        first = await reset_client.post("/api/auth/reset-password", json=payload)
        assert first.status_code == 200

        second = await reset_client.post("/api/auth/reset-password", json=payload)
        assert second.status_code == 400
        assert "reset token" in second.json()["detail"].lower()

    async def test_unknown_token_rejected(self, reset_client):
        resp = await reset_client.post(
            "/api/auth/reset-password",
            json={"token": "not-a-real-token", "new_password": "newsecret456"},
        )
        assert resp.status_code == 400

    async def test_expired_token_rejected(self, reset_client, db_session):
        user = db_session.query(Patient).filter(Patient.email == TEST_USER_EMAIL).first()
        raw_token = "expiredrawtoken123456"
        db_session.add(PasswordResetToken(
            id="expired-token",
            patient_id=user.id,
            token_hash=hashlib.sha256(raw_token.encode()).hexdigest(),
            expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        ))
        db_session.commit()

        resp = await reset_client.post(
            "/api/auth/reset-password",
            json={"token": raw_token, "new_password": "newsecret456"},
        )
        assert resp.status_code == 400
        assert "reset token" in resp.json()["detail"].lower()

    async def test_short_password_rejected(self, reset_client, db_session, captured_emails):
        token = await self._request_token(reset_client, captured_emails)
        resp = await reset_client.post(
            "/api/auth/reset-password",
            json={"token": token, "new_password": "short"},
        )
        assert resp.status_code == 400
        assert "at least" in resp.json()["detail"]
        assert authenticate_user(db_session, TEST_USER_EMAIL, "short") is None


class TestRegisterValidation:
    async def test_short_password_rejected(self, reset_client):
        resp = await reset_client.post(
            "/api/auth/register",
            json={
                "email": "newuser@example.com",
                "password": "short",
                "name": "New User",
                "dob": "1990-01-01",
                "gender": "Other",
            },
        )
        assert resp.status_code == 400
        assert "at least" in resp.json()["detail"]
