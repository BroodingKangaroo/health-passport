"""Email change (roadmap 0.4): request + confirm.

Double opt-in by construction — requesting is authenticated (password
re-verified) and changes nothing; only the one-time link sent to the NEW
address switches ``patients.email``. Covers the pending-token rules, the
conflict paths, the old-address notice and localized errors.
"""

import hashlib
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import pytest

from app.api import auth as auth_api
from app.db.models import EmailChangeToken, Patient
from tests.seed_data import TEST_USER_EMAIL, TEST_USER_ID, TEST_USER_PASSWORD

OTHER_USER_ID = "otheruser"
OTHER_USER_EMAIL = "other@example.com"


@pytest.fixture(autouse=True)
def _clear_throttle():
    """The throttle is module-global state; keep tests independent."""
    auth_api._throttle_windows.clear()
    yield


@pytest.fixture
def sent_mail(monkeypatch):
    """Capture the email-change messages instead of sending them."""
    captured = {"confirmation": [], "notice": [], "reset": [], "squatted": []}

    def fake_confirmation(email, confirm_url):
        captured["confirmation"].append((email, confirm_url))

    def fake_notice(old_email, new_email, reset_url):
        captured["notice"].append((old_email, new_email, reset_url))

    def fake_reset(email, reset_url):
        captured["reset"].append((email, reset_url))

    def fake_squatted(email):
        captured["squatted"].append(email)

    monkeypatch.setattr(auth_api, "send_email_change_email", fake_confirmation)
    monkeypatch.setattr(auth_api, "send_email_change_notice", fake_notice)
    monkeypatch.setattr(auth_api, "send_reset_email", fake_reset)
    monkeypatch.setattr(auth_api, "send_email_change_squatted_notice", fake_squatted)
    return captured


def _make_client(db_session, *, authenticated=True):
    """Auth-router client; authenticated resolves to the seeded test user."""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.api.auth import get_current_user
    from app.db.session import get_db
    from app.i18n import LocaleMiddleware

    app = FastAPI()
    app.include_router(auth_api.router)
    app.add_middleware(LocaleMiddleware)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    if authenticated:
        async def override_get_current_user():
            return db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()

        app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


def _add_other_user(db_session) -> None:
    db_session.add(Patient(
        id=OTHER_USER_ID,
        email=OTHER_USER_EMAIL,
        hashed_password="x",
        name="Other User",
        dob="1980-01-01",
        gender="Other",
        external_id="HP-TEST-0002",
    ))
    db_session.commit()


def _token_from_url(confirm_url: str) -> str:
    qs = urlparse(confirm_url).query
    return dict(pair.split("=", 1) for pair in qs.split("&"))["token"]


def _pending_token(db_session, raw_token: str) -> EmailChangeToken:
    return db_session.query(EmailChangeToken).filter(
        EmailChangeToken.token_hash == hashlib.sha256(raw_token.encode()).hexdigest()
    ).one()


class TestChangeEmailRequest:
    async def test_sends_confirmation_and_changes_nothing_yet(
        self, db_session, sent_mail, monkeypatch
    ):
        monkeypatch.setattr(auth_api, "FRONTEND_URL", "https://app.example")
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/change-email",
                json={
                    "current_password": TEST_USER_PASSWORD,
                    "new_email": "new@example.com",
                },
            )

        assert resp.status_code == 200
        assert "new@example.com" in resp.json()["message"]

        # The account keeps its address until the link is opened.
        user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
        assert user.email == TEST_USER_EMAIL

        assert len(sent_mail["confirmation"]) == 1
        email, confirm_url = sent_mail["confirmation"][0]
        assert email == "new@example.com"
        assert confirm_url.startswith("https://app.example/confirm-email-change?token=")

        # Only the hash is persisted, with the pending address and a TTL.
        row = _pending_token(db_session, _token_from_url(confirm_url))
        assert row.new_email == "new@example.com"
        assert row.used_at is None
        assert row.expires_at.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc)

    async def test_requires_the_current_password(self, db_session, sent_mail):
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/change-email",
                json={
                    "current_password": "wrong-password",
                    "new_email": "new@example.com",
                },
            )

        assert resp.status_code == 400
        assert "incorrect" in resp.json()["detail"].lower()
        assert db_session.query(EmailChangeToken).count() == 0
        assert sent_mail["confirmation"] == []

    async def test_rejects_the_current_address(self, db_session, sent_mail):
        async with _make_client(db_session) as ac:
            # Case-insensitive: same identity, so there is nothing to confirm.
            resp = await ac.post(
                "/api/auth/change-email",
                json={
                    "current_password": TEST_USER_PASSWORD,
                    "new_email": TEST_USER_EMAIL.upper(),
                },
            )

        assert resp.status_code == 400
        assert db_session.query(EmailChangeToken).count() == 0
        assert sent_mail["confirmation"] == []

    async def test_an_address_owned_by_another_account_is_not_disclosed(
        self, db_session, sent_mail
    ):
        """Anti-enumeration: a taken address must be indistinguishable from a
        free one (uniform 200, no token staged here), and the ADDRESS OWNER is
        warned instead of the caller being told."""
        _add_other_user(db_session)
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/change-email",
                json={
                    "current_password": TEST_USER_PASSWORD,
                    "new_email": OTHER_USER_EMAIL,
                },
            )

        assert resp.status_code == 200
        assert OTHER_USER_EMAIL in resp.json()["message"]
        assert db_session.query(EmailChangeToken).count() == 0
        assert sent_mail["confirmation"] == []
        assert sent_mail["squatted"] == [OTHER_USER_EMAIL]
        # Neither account moved.
        assert db_session.query(Patient).filter(Patient.id == TEST_USER_ID).one().email == TEST_USER_EMAIL
        assert db_session.query(Patient).filter(Patient.id == OTHER_USER_ID).one().email == OTHER_USER_EMAIL

    async def test_anonymous_is_401(self, db_session):
        async with _make_client(db_session, authenticated=False) as ac:
            resp = await ac.post(
                "/api/auth/change-email",
                json={
                    "current_password": TEST_USER_PASSWORD,
                    "new_email": "new@example.com",
                },
            )
        assert resp.status_code == 401

    async def test_throttled_after_repeated_requests(self, db_session):
        payload = {
            "current_password": TEST_USER_PASSWORD,
            "new_email": "new@example.com",
        }
        async with _make_client(db_session) as ac:
            for _ in range(auth_api._EMAIL_CHANGE_LIMIT):
                resp = await ac.post("/api/auth/change-email", json=payload)
                assert resp.status_code == 200
            throttled = await ac.post("/api/auth/change-email", json=payload)

        assert throttled.status_code == 429

    async def test_error_is_localized(self, db_session):
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/change-email",
                json={
                    "current_password": "wrong-password",
                    "new_email": "new@example.com",
                },
                headers={"Accept-Language": "ru"},
            )
        assert resp.status_code == 400
        assert "пароль" in resp.json()["detail"].lower()


class TestConfirmEmailChange:
    async def _request_change(self, db_session, sent_mail, new_email="new@example.com"):
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/change-email",
                json={"current_password": TEST_USER_PASSWORD, "new_email": new_email},
            )
        assert resp.status_code == 200
        return _token_from_url(sent_mail["confirmation"][-1][1])

    async def test_switches_address_and_warns_the_old_one(
        self, db_session, sent_mail, monkeypatch
    ):
        monkeypatch.setattr(auth_api, "FRONTEND_URL", "https://app.example")
        raw_token = await self._request_change(db_session, sent_mail)

        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/confirm-email-change", json={"token": raw_token}
            )

        assert resp.status_code == 200
        user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
        assert user.email == "new@example.com"

        assert _pending_token(db_session, raw_token).used_at is not None
        assert len(sent_mail["notice"]) == 1
        old_email, new_email, reset_url = sent_mail["notice"][0]
        assert (old_email, new_email) == (TEST_USER_EMAIL, "new@example.com")
        assert reset_url.startswith("https://app.example/forgot-password")

    async def test_unknown_token_is_rejected(self, db_session):
        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/confirm-email-change", json={"token": "not-a-token"}
            )
        assert resp.status_code == 400
        user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
        assert user.email == TEST_USER_EMAIL

    async def test_expired_token_is_rejected(self, db_session, sent_mail):
        raw_token = await self._request_change(db_session, sent_mail)
        row = _pending_token(db_session, raw_token)
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db_session.commit()

        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/confirm-email-change", json={"token": raw_token}
            )
        assert resp.status_code == 400
        user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
        assert user.email == TEST_USER_EMAIL

    async def test_token_is_single_use(self, db_session, sent_mail):
        raw_token = await self._request_change(db_session, sent_mail)

        async with _make_client(db_session) as ac:
            first = await ac.post(
                "/api/auth/confirm-email-change", json={"token": raw_token}
            )
            # Move the address away first so a successful replay would be
            # observable, then replay the already-consumed token.
            user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
            user.email = "interim@example.com"
            db_session.commit()
            replay = await ac.post(
                "/api/auth/confirm-email-change", json={"token": raw_token}
            )

        assert first.status_code == 200
        assert replay.status_code == 400
        db_session.refresh(user)
        assert user.email == "interim@example.com"

    async def test_conflict_when_address_is_taken_in_the_meantime(
        self, db_session, sent_mail
    ):
        raw_token = await self._request_change(db_session, sent_mail)
        # Another account takes the address while the link is pending.
        _add_other_user(db_session)
        other = db_session.query(Patient).filter(Patient.id == OTHER_USER_ID).first()
        other.email = "new@example.com"
        db_session.commit()

        async with _make_client(db_session) as ac:
            resp = await ac.post(
                "/api/auth/confirm-email-change", json={"token": raw_token}
            )

        assert resp.status_code == 409
        user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
        assert user.email == TEST_USER_EMAIL
        assert sent_mail["notice"] == []
