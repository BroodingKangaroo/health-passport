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
from tests.seed_data import TEST_USER_EMAIL, seed_test_db


@pytest.fixture(autouse=True)
def _clear_throttle():
    """The throttle is module-global state; keep tests independent."""
    auth_api._throttle_windows.clear()
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


@pytest_asyncio.fixture
async def file_backed_reset_client(tmp_path):
    """Auth client on a FILE-backed engine.

    In-memory sqlite (``SingletonThreadPool``) shares one connection, so a
    second session sees uncommitted state — useless for asserting that a
    request actually COMMITTED. File-backed lets tests open an independent
    connection to verify persistence and to simulate concurrent writes.
    """
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.api.auth import get_db
    from app.db.session import Base, configure_sqlite_engine

    engine = create_engine(f"sqlite:///{tmp_path}/auth.db")
    configure_sqlite_engine(engine)
    Base.metadata.create_all(bind=engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db = TestingSessionLocal()
    seed_test_db(db)

    app = FastAPI()
    app.include_router(auth_api.router)

    async def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, db, TestingSessionLocal, engine
    db.close()
    Base.metadata.drop_all(bind=engine)



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


class TestLoginThrottle:
    """ISSUES.md #51: failed login attempts are throttled per-email and
    per-IP; successful logins never count against the window."""

    @pytest.fixture
    def login_client(self):
        """A dedicated client on a StaticPool in-memory DB: `login` is a sync
        endpoint executed in the threadpool, so a plain in-memory engine
        (SingletonThreadPool) would hand the thread an empty database."""
        from fastapi import FastAPI
        from httpx import ASGITransport, AsyncClient
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool

        from app.db.session import Base

        engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        Base.metadata.create_all(bind=engine)
        session = TestingSessionLocal()
        seed_test_db(session)

        from app.db.session import get_db

        app = FastAPI()
        app.include_router(auth_api.router)

        async def override_get_db():
            yield session

        app.dependency_overrides[get_db] = override_get_db
        transport = ASGITransport(app=app)
        yield AsyncClient(transport=transport, base_url="http://test")
        session.close()
        Base.metadata.drop_all(bind=engine)

    async def test_locks_out_after_repeated_failures(self, login_client):
        body = {"username": TEST_USER_EMAIL, "password": "wrong-password"}
        for _ in range(10):
            resp = await login_client.post("/api/auth/login", data=body)
            assert resp.status_code == 401
        throttled = await login_client.post("/api/auth/login", data=body)
        assert throttled.status_code == 429

    async def test_correct_password_after_failures_still_throttled(
        self, login_client
    ):
        from tests.seed_data import TEST_USER_PASSWORD

        body = {"username": TEST_USER_EMAIL, "password": "wrong-password"}
        for _ in range(10):
            await login_client.post("/api/auth/login", data=body)
        # Even the CORRECT password is refused while the failure window is
        # full — that is what makes the throttle a brute-force defense.
        resp = await login_client.post(
            "/api/auth/login",
            data={"username": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD},
        )
        assert resp.status_code == 429

    async def test_successful_logins_do_not_consume_window(
        self, login_client
    ):
        from tests.seed_data import TEST_USER_PASSWORD

        good = {"username": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD}
        for _ in range(15):
            resp = await login_client.post("/api/auth/login", data=good)
            assert resp.status_code == 200


class TestForgotPasswordPurgePersistence:
    async def test_unknown_email_commit_persists_purge(self, file_backed_reset_client):
        """The opportunistic stale-token purge must persist even when the
        email is unknown (get_db only closes, which would roll it back)."""
        client, db, TestingSessionLocal, _engine = file_backed_reset_client
        user = db.query(Patient).filter(Patient.email == TEST_USER_EMAIL).one()
        raw = "stale-raw-token-unknown-email"
        db.add(PasswordResetToken(
            id="stale-token",
            patient_id=user.id,
            token_hash=hashlib.sha256(raw.encode()).hexdigest(),
            expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
        ))
        db.commit()

        resp = await client.post(
            "/api/auth/forgot-password", json={"email": "nobody@example.com"}
        )
        assert resp.status_code == 200

        # An INDEPENDENT connection only sees the purge if it was committed.
        other = TestingSessionLocal()
        try:
            assert other.query(PasswordResetToken).count() == 0
        finally:
            other.close()


class TestResetTokenClaim:
    async def test_concurrent_claim_loses_without_touching_password(
        self, file_backed_reset_client
    ):
        """A concurrent request that claims the token between this request's
        read and its claim UPDATE must win: the conditional claim matches 0
        rows, yields 400, and must not set the password."""
        from sqlalchemy import event, update

        from tests.seed_data import TEST_USER_PASSWORD

        client, db, TestingSessionLocal, engine = file_backed_reset_client
        user = db.query(Patient).filter(Patient.email == TEST_USER_EMAIL).one()
        raw_token = "race-raw-token-123456"
        db.add(PasswordResetToken(
            id="race-token",
            patient_id=user.id,
            token_hash=hashlib.sha256(raw_token.encode()).hexdigest(),
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        ))
        db.commit()

        def concurrent_winner():
            other = TestingSessionLocal()
            try:
                other.execute(
                    update(PasswordResetToken)
                    .where(PasswordResetToken.id == "race-token")
                    .values(used_at=datetime.now(timezone.utc))
                )
                other.commit()
            finally:
                other.close()

        state = {"fired": False}

        @event.listens_for(engine, "before_cursor_execute")
        def _claim_race_hook(conn, cursor, statement, parameters, context, executemany):
            # `fired` is set BEFORE the winner runs so its own UPDATE (same
            # engine) does not recurse into the hook.
            if state["fired"]:
                return
            stmt = statement.lstrip().upper()
            if stmt.startswith("UPDATE") and "PASSWORD_RESET_TOKENS" in stmt:
                state["fired"] = True
                concurrent_winner()

        try:
            resp = await client.post(
                "/api/auth/reset-password",
                json={"token": raw_token, "new_password": "loserpass123"},
            )
        finally:
            event.remove(engine, "before_cursor_execute", _claim_race_hook)

        assert state["fired"] is True
        assert resp.status_code == 400
        assert "reset token" in resp.json()["detail"].lower()

        db.expire_all()
        assert authenticate_user(db, TEST_USER_EMAIL, "loserpass123") is None
        assert authenticate_user(db, TEST_USER_EMAIL, TEST_USER_PASSWORD) is not None


class TestPasswordLengthCap:
    """bcrypt truncates at 72 bytes; longer passwords must be rejected up
    front on every password-setting path (register/change/reset)."""

    async def test_register_rejects_oversized(self, reset_client):
        resp = await reset_client.post(
            "/api/auth/register",
            json={
                "email": "oversized@example.com",
                "password": "a" * 73,
                "name": "Oversized",
                "dob": "1990-01-01",
                "gender": "Other",
            },
        )
        assert resp.status_code == 400
        assert "72" in resp.json()["detail"]

    async def test_reset_rejects_oversized_ascii(self, reset_client, db_session, captured_emails):
        await reset_client.post("/api/auth/forgot-password", json={"email": TEST_USER_EMAIL})
        token = _token_from_url(captured_emails[0][1])

        resp = await reset_client.post(
            "/api/auth/reset-password",
            json={"token": token, "new_password": "a" * 73},
        )
        assert resp.status_code == 400
        assert "72" in resp.json()["detail"]
        # The password was not changed (bcrypt itself raises on >72 bytes,
        # so the old hash must still be the one in place).
        assert authenticate_user(db_session, TEST_USER_EMAIL, "testpassword123") is not None

    async def test_reset_rejects_oversized_multibyte(self, reset_client, db_session, captured_emails):
        """The cap is in bytes: 37 Cyrillic chars = 74 bytes even though the
        character count (37) is far below 72."""
        await reset_client.post("/api/auth/forgot-password", json={"email": TEST_USER_EMAIL})
        token = _token_from_url(captured_emails[0][1])

        oversized = "я" * 37
        assert len(oversized.encode("utf-8")) == 74
        resp = await reset_client.post(
            "/api/auth/reset-password",
            json={"token": token, "new_password": oversized},
        )
        assert resp.status_code == 400
        assert "72" in resp.json()["detail"]

    async def test_reset_accepts_exactly_72_bytes(self, reset_client, db_session, captured_emails):
        await reset_client.post("/api/auth/forgot-password", json={"email": TEST_USER_EMAIL})
        token = _token_from_url(captured_emails[0][1])

        boundary = "я" * 36
        assert len(boundary.encode("utf-8")) == 72
        resp = await reset_client.post(
            "/api/auth/reset-password",
            json={"token": token, "new_password": boundary},
        )
        assert resp.status_code == 200
        assert authenticate_user(db_session, TEST_USER_EMAIL, boundary) is not None


class TestThrottleMapBound:
    """The in-memory throttle map must not grow without bound: stale windows
    are dropped and a hard cap evicts the least-recently-active keys."""

    def test_stale_keys_are_evicted(self):
        now = datetime.now(timezone.utc)
        auth_api._throttle_windows["reset:email:old@example.com"].append(
            now - timedelta(hours=2)
        )
        auth_api._prune_throttle_keys()
        assert "reset:email:old@example.com" not in auth_api._throttle_windows

    def test_hard_cap_bounds_map(self):
        now = datetime.now(timezone.utc)
        total = auth_api._THROTTLE_MAX_KEYS + 50
        for i in range(total):
            # Oldest first when `i` is largest (all within the TTL window).
            auth_api._throttle_windows[f"key:{i}"].append(
                now - timedelta(microseconds=i)
            )

        auth_api._prune_throttle_keys()

        assert len(auth_api._throttle_windows) == auth_api._THROTTLE_MAX_KEYS
        assert "key:0" in auth_api._throttle_windows
        assert f"key:{total - 1}" not in auth_api._throttle_windows
