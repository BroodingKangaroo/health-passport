"""Unit tests for `app/services/mailer.py` (roadmap 0.4).

The senders were previously covered only through the endpoint tests, which
monkeypatch them away — the transport, the message bodies and the
"never log a live link in production" guard had no coverage at all.
"""

import logging
from typing import ClassVar

import pytest

from app.services import mailer

RESET_URL = "https://app.example/reset-password?token=reset-raw"
CONFIRM_URL = "https://app.example/confirm-email-change?token=confirm-raw"


class _FakeSMTP:
    """Minimal smtplib.SMTP stand-in recording the delivery handshake."""

    instances: ClassVar[list["_FakeSMTP"]] = []
    implicit_tls = False

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.started_tls = False
        self.logged_in = None
        self.messages = []
        _FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self):
        self.started_tls = True

    def login(self, user, password):
        self.logged_in = (user, password)

    def send_message(self, msg):
        self.messages.append(msg)


class _FakeSMTPSSL(_FakeSMTP):
    """Implicit-TLS stand-in (``smtplib.SMTP_SSL``): TLS from the first byte,
    so no STARTTLS upgrade happens."""

    implicit_tls = True


@pytest.fixture(autouse=True)
def _clear_instances():
    _FakeSMTP.instances.clear()
    yield


@pytest.fixture
def smtp_on(monkeypatch):
    """SMTP configured with TLS + credentials, transport faked."""
    monkeypatch.setattr(mailer, "SMTP_ENABLED", True)
    monkeypatch.setattr(mailer, "SMTP_TLS", True)
    monkeypatch.setattr(mailer, "SMTP_SECURITY", "")
    monkeypatch.setattr(mailer, "SMTP_USER", "robot@example.com")
    monkeypatch.setattr(mailer, "SMTP_PASSWORD", "app-password")
    monkeypatch.setattr(mailer, "SMTP_FROM", "no-reply@example.com")
    monkeypatch.setattr(mailer.smtplib, "SMTP", _FakeSMTP)
    monkeypatch.setattr(mailer.smtplib, "SMTP_SSL", _FakeSMTPSSL)
    return _FakeSMTP.instances


@pytest.fixture
def smtp_configured(monkeypatch):
    """SMTP on with credentials, transport faked, security left UNSET so each
    test chooses the mode (and can exercise the fail-closed default)."""
    monkeypatch.setattr(mailer, "SMTP_ENABLED", True)
    monkeypatch.setattr(mailer, "SMTP_TLS", False)
    monkeypatch.setattr(mailer, "SMTP_SECURITY", "")
    monkeypatch.setattr(mailer, "SMTP_USER", "robot@example.com")
    monkeypatch.setattr(mailer, "SMTP_PASSWORD", "app-password")
    monkeypatch.setattr(mailer, "SMTP_FROM", "no-reply@example.com")
    monkeypatch.setattr(mailer.smtplib, "SMTP", _FakeSMTP)
    monkeypatch.setattr(mailer.smtplib, "SMTP_SSL", _FakeSMTPSSL)
    return _FakeSMTP.instances


@pytest.fixture
def smtp_off(monkeypatch):
    monkeypatch.setattr(mailer, "SMTP_ENABLED", False)


class TestNoTransport:
    def test_logs_the_link_outside_production(self, smtp_off, caplog, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "development")
        with caplog.at_level(logging.WARNING, logger="app.services.mailer"):
            mailer.send_reset_email("user@example.com", RESET_URL)

        assert RESET_URL in caplog.text
        assert _FakeSMTP.instances == []

    def test_never_logs_a_live_link_in_production(self, smtp_off, caplog, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "production")
        with caplog.at_level(logging.WARNING, logger="app.services.mailer"):
            mailer.send_reset_email("user@example.com", RESET_URL)
            mailer.send_email_change_email("user@example.com", CONFIRM_URL)

        assert "was NOT sent" in caplog.text
        # Anyone with log access could otherwise take over the account.
        assert RESET_URL not in caplog.text
        assert CONFIRM_URL not in caplog.text

    def test_delivery_enabled_reflects_config(self, smtp_off, monkeypatch):
        assert mailer.email_delivery_enabled() is False
        monkeypatch.setattr(mailer, "SMTP_ENABLED", True)
        assert mailer.email_delivery_enabled() is True


class TestDelivery:
    def test_reset_email_over_starttls_with_login(self, smtp_on):
        mailer.send_reset_email("user@example.com", RESET_URL)

        assert len(smtp_on) == 1
        server = smtp_on[0]
        assert server.started_tls is True
        assert server.logged_in == ("robot@example.com", "app-password")

        msg = server.messages[0]
        assert msg["To"] == "user@example.com"
        assert msg["From"] == "no-reply@example.com"
        assert "password" in msg["Subject"].lower()
        body = msg.get_content()
        assert RESET_URL in body
        # Bilingual by design: no per-user language preference exists.
        assert "Сброс" in msg["Subject"]

    def test_email_change_confirmation_goes_to_the_new_address(self, smtp_on):
        mailer.send_email_change_email("new@example.com", CONFIRM_URL)
        msg = smtp_on[0].messages[0]
        assert msg["To"] == "new@example.com"
        assert CONFIRM_URL in msg.get_content()

    def test_email_change_notice_names_both_addresses(self, smtp_on):
        mailer.send_email_change_notice(
            "old@example.com", "new@example.com", "https://app.example/forgot-password"
        )
        msg = smtp_on[0].messages[0]
        assert msg["To"] == "old@example.com"
        body = msg.get_content()
        assert "new@example.com" in body
        assert "https://app.example/forgot-password" in body

    def test_email_change_squatted_notice_has_no_link(self, smtp_on):
        """Sent to an address someone tried to claim: it warns, claims nothing,
        and carries no link (there is nothing to confirm)."""
        mailer.send_email_change_squatted_notice("taken@example.com")
        msg = smtp_on[0].messages[0]
        assert msg["To"] == "taken@example.com"
        body = msg.get_content()
        assert "Nothing changed" in body
        assert "token=" not in body

    def test_failure_is_logged_not_raised(self, caplog):
        def boom(email, url):
            raise ConnectionError("SMTP down")

        with caplog.at_level(logging.ERROR, logger="app.services.mailer"):
            # The response is already written when this runs; raising here
            # would only surface as an ASGI application error.
            mailer.deliver("password reset", boom, "user@example.com", RESET_URL)

        assert "email delivery failed" in caplog.text


class TestTransportSecurity:
    """`SMTP_SECURITY=starttls|ssl|none`, with the legacy `SMTP_TLS` flag still
    honoured — and credentials over plaintext refused unless the operator
    opted out explicitly."""

    def test_legacy_tls_flag_still_selects_starttls(self, smtp_configured, monkeypatch):
        monkeypatch.setattr(mailer, "SMTP_TLS", True)
        mailer.send_reset_email("user@example.com", RESET_URL)

        server = smtp_configured[0]
        assert type(server) is _FakeSMTP
        assert server.started_tls is True

    def test_starttls_mode_upgrades_before_login(self, smtp_configured, monkeypatch):
        monkeypatch.setattr(mailer, "SMTP_SECURITY", "starttls")
        mailer.send_reset_email("user@example.com", RESET_URL)

        server = smtp_configured[0]
        assert type(server) is _FakeSMTP
        assert server.started_tls is True
        assert server.logged_in == ("robot@example.com", "app-password")

    def test_ssl_mode_uses_implicit_tls_not_starttls(self, smtp_configured, monkeypatch):
        monkeypatch.setattr(mailer, "SMTP_SECURITY", "ssl")
        mailer.send_reset_email("user@example.com", RESET_URL)

        server = smtp_configured[0]
        assert isinstance(server, _FakeSMTPSSL)
        assert server.implicit_tls is True
        # Implicit TLS is encrypted from the first byte; STARTTLS on top of it
        # would be a protocol error.
        assert server.started_tls is False
        assert server.logged_in == ("robot@example.com", "app-password")

    def test_explicit_security_mode_beats_the_legacy_flag(self, smtp_configured, monkeypatch):
        monkeypatch.setattr(mailer, "SMTP_TLS", True)
        monkeypatch.setattr(mailer, "SMTP_SECURITY", "ssl")
        mailer.send_reset_email("user@example.com", RESET_URL)
        assert isinstance(smtp_configured[0], _FakeSMTPSSL)

    def test_credentials_without_tls_are_refused(self, smtp_configured):
        """The dangerous default: SMTP_USER/PASSWORD set, SMTP_TLS forgotten.
        Fail closed — and do not even open the plaintext connection."""
        with pytest.raises(RuntimeError, match="unencrypted"):
            mailer.send_reset_email("user@example.com", RESET_URL)
        assert smtp_configured == []

    def test_deliver_logs_the_refusal_instead_of_raising(self, smtp_configured, caplog):
        with caplog.at_level(logging.ERROR, logger="app.services.mailer"):
            mailer.deliver("password reset", mailer.send_reset_email, "user@example.com", RESET_URL)
        assert "email delivery failed" in caplog.text

    def test_explicit_none_is_the_plaintext_opt_out(self, smtp_configured, monkeypatch):
        monkeypatch.setattr(mailer, "SMTP_SECURITY", "none")
        mailer.send_reset_email("user@example.com", RESET_URL)

        server = smtp_configured[0]
        assert server.started_tls is False
        assert server.logged_in == ("robot@example.com", "app-password")

    def test_no_credentials_allow_a_plaintext_relay(self, smtp_configured, monkeypatch):
        monkeypatch.setattr(mailer, "SMTP_USER", "")
        mailer.send_reset_email("user@example.com", RESET_URL)

        server = smtp_configured[0]
        assert server.started_tls is False
        assert server.logged_in is None


class TestEmailDeliveryStatus:
    """`GET /api/auth/email-delivery` — the instance-level capability flag.

    The reset endpoint answers 200 for every address (no user enumeration), so
    this flag is the only honest way for the UI to say "no mail will arrive".
    """

    @staticmethod
    async def _status(monkeypatch, enabled: bool) -> bool:
        from fastapi import FastAPI
        from httpx import ASGITransport, AsyncClient

        from app.api.auth import router

        monkeypatch.setattr(mailer, "SMTP_ENABLED", enabled)
        app = FastAPI()
        app.include_router(router)
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            resp = await ac.get("/api/auth/email-delivery")
        assert resp.status_code == 200
        return resp.json()["enabled"]

    async def test_reports_disabled_without_smtp(self, monkeypatch):
        assert await self._status(monkeypatch, False) is False

    async def test_reports_enabled_with_smtp(self, monkeypatch):
        assert await self._status(monkeypatch, True) is True
