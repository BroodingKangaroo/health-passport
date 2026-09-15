"""
Email delivery for HealthPassport (password reset, email change).

Uses stdlib ``smtplib`` with SMTP_* env settings from ``config``. When SMTP
is not configured (local dev), the one-time link is logged instead so the
flows remain testable end-to-end without a mail server — never in production
(``ENVIRONMENT=production``), where a logged link would be a live reset.
"""

import logging
import os
import smtplib
from email.message import EmailMessage
from typing import Optional

from config import (
    SMTP_ENABLED,
    SMTP_FROM,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_SECURITY,
    SMTP_TLS,
    SMTP_USER,
)

logger = logging.getLogger(__name__)

# Transport security modes. "starttls" = plain connect then STARTTLS upgrade
# (submission port 587); "ssl" = implicit TLS from the first byte (port 465,
# which several providers mandate); "none" = plaintext.
_SECURITY_MODES = ("starttls", "ssl", "none")


def _is_production() -> bool:
    return os.getenv("ENVIRONMENT", "").strip().lower() in ("production", "prod")


def _security_mode() -> str:
    """Resolve the effective transport security.

    An explicit ``SMTP_SECURITY`` wins; otherwise the legacy ``SMTP_TLS`` flag
    decides (true → starttls, false → none), so existing deployments keep
    working unchanged.
    """
    if SMTP_SECURITY in _SECURITY_MODES:
        return SMTP_SECURITY
    return "starttls" if SMTP_TLS else "none"


def _credentials_on_plaintext() -> bool:
    """True when credentials would be sent over an unencrypted connection
    WITHOUT the operator explicitly opting out via ``SMTP_SECURITY=none``."""
    return bool(SMTP_USER) and _security_mode() == "none" and SMTP_SECURITY != "none"


def _log_undelivered(kind: str, email: str, link: Optional[str] = None) -> None:
    """No SMTP transport: warn, and log the one-time link only outside production."""
    if _is_production():
        # Never write a live one-time link to logs in production: anyone with
        # log access could otherwise reset any account.
        logger.warning(
            "%s email for %s was NOT sent (SMTP_ENABLED is off)", kind, email
        )
    elif link is None:
        logger.warning("%s for %s was not sent (SMTP_ENABLED is off)", kind, email)
    else:
        # Local-dev convenience: the flows stay testable without a mail server.
        logger.warning("%s link for %s: %s", kind, email, link)


def _send(to: str, subject: str, body: str) -> None:
    """Deliver one plain-text message over SMTP."""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = to
    msg.set_content(body)

    mode = _security_mode()
    if _credentials_on_plaintext():
        # Fail closed: an operator who set credentials but no transport
        # security almost certainly forgot the flag, and a silently-cleartext
        # login leaks the mailbox password. SMTP_SECURITY=none is the
        # deliberate opt-out.
        raise RuntimeError(
            "Refusing to send SMTP credentials over an unencrypted connection: "
            "set SMTP_SECURITY=starttls (port 587) or SMTP_SECURITY=ssl (port 465), "
            "or SMTP_SECURITY=none to accept plaintext explicitly."
        )

    # Implicit TLS talks TLS from the first byte, so it uses SMTP_SSL rather
    # than the STARTTLS upgrade on a plain connection.
    smtp_cls = smtplib.SMTP_SSL if mode == "ssl" else smtplib.SMTP
    with smtp_cls(SMTP_HOST, SMTP_PORT, timeout=30) as server:
        if mode == "starttls":
            server.starttls()
        if SMTP_USER:
            server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(msg)


def deliver(kind: str, send, *args) -> None:
    """Run one send with failures logged instead of raised.

    Runs from a Starlette ``BackgroundTasks`` step, i.e. after the HTTP
    response has been written — an escaping exception could only surface as a
    noisy ASGI application error. Delivery failure is an ops signal, not a
    client-visible state: the reset endpoint must stay uniform (no user
    enumeration), and the email-change flow already tells the user to check
    the inbox rather than the SMTP handshake.
    """
    try:
        send(*args)
    except Exception:
        logger.exception("email delivery failed — %s", kind)


def email_delivery_enabled() -> bool:
    """True when a real SMTP transport is configured."""
    return SMTP_ENABLED


def send_reset_email(email: str, reset_url: str) -> None:
    """Email a password-reset link, or log it when SMTP is not configured."""
    if not SMTP_ENABLED:
        _log_undelivered("password reset", email, reset_url)
        return

    # Bilingual (English + Russian) body: there is no per-user language
    # preference in the data model, so both languages travel in one email and
    # the recipient reads whichever block they need.
    _send(
        email,
        "Reset your HealthPassport password / Сброс пароля HealthPassport",
        "You requested a password reset for your HealthPassport account.\n\n"
        "Open the link below to choose a new password (valid for 30 minutes):\n\n"
        f"{reset_url}\n\n"
        "If you didn't request this, you can safely ignore this email.\n"
        "\n"
        "———————————————————————————————\n"
        "\n"
        "Вы запросили сброс пароля для вашего аккаунта HealthPassport.\n\n"
        "Откройте ссылку ниже, чтобы задать новый пароль (действительна 30 минут):\n\n"
        f"{reset_url}\n\n"
        "Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.\n",
    )


def send_email_change_email(email: str, confirm_url: str) -> None:
    """Email a confirmation link for a pending email change to the NEW address.

    The account keeps its current address until this link is opened, so a typo
    cannot silently lock the owner out.
    """
    if not SMTP_ENABLED:
        _log_undelivered("email change confirmation", email, confirm_url)
        return

    _send(
        email,
        "Confirm your new HealthPassport email / Подтвердите новый email HealthPassport",
        "You asked to use this address for your HealthPassport account.\n\n"
        "Open the link below to confirm the change (valid for 30 minutes):\n\n"
        f"{confirm_url}\n\n"
        "If you didn't request this, ignore this email — nothing will change.\n"
        "\n"
        "———————————————————————————————\n"
        "\n"
        "Вы указали этот адрес как новый email для аккаунта HealthPassport.\n\n"
        "Откройте ссылку ниже, чтобы подтвердить изменение (действительна 30 минут):\n\n"
        f"{confirm_url}\n\n"
        "Если вы этого не запрашивали, просто проигнорируйте письмо — ничего не изменится.\n",
    )


def send_email_change_notice(old_email: str, new_email: str, reset_url: str) -> None:
    """Warn the OLD address that the account's email was changed.

    Lets the previous owner notice and recover via password reset if the change
    was not theirs. Confirming an email change bumps the account's session
    version, so sessions issued under the old address are already dead by the
    time this lands — the /forgot-password link is the path to a fresh login.
    """
    if not SMTP_ENABLED:
        _log_undelivered("email change notice", old_email, new_email)
        return

    _send(
        old_email,
        "Your HealthPassport email was changed / Email HealthPassport изменён",
        "The email address of your HealthPassport account was changed to "
        f"{new_email}.\n\n"
        "If you did this, no action is needed. If you did not, reset your "
        "password immediately:\n\n"
        f"{reset_url}\n"
        "\n"
        "———————————————————————————————\n"
        "\n"
        f"Email вашего аккаунта HealthPassport изменён на {new_email}.\n\n"
        "Если это были вы — ничего делать не нужно. Если нет — немедленно "
        "сбросьте пароль:\n\n"
        f"{reset_url}\n",
    )


def send_email_change_squatted_notice(email: str) -> None:
    """Warn an address that someone tried to claim it for another account.

    `POST /api/auth/change-email` cannot answer "that address is taken"
    without becoming a user-enumeration oracle, so it answers uniformly and
    tells the address owner instead. Nothing changed and nothing can be
    confirmed, so there is no link to follow — and deliberately no detail
    about the account that asked.
    """
    if not SMTP_ENABLED:
        _log_undelivered("email change address notice", email)
        return

    _send(
        email,
        "Your HealthPassport email was requested / Запрошено изменение email HealthPassport",
        "Someone tried to use this email address for a different HealthPassport "
        "account.\n\n"
        "Nothing changed: this address already belongs to an account, so no "
        "confirmation link was sent and no other account can take it over. If "
        "this wasn't you, no action is needed.\n"
        "\n"
        "———————————————————————————————\n"
        "\n"
        "Кто-то попытался использовать этот адрес email для другого аккаунта "
        "HealthPassport.\n\n"
        "Ничего не изменилось: этот адрес уже принадлежит аккаунту, поэтому "
        "ссылка не отправлена и другой аккаунт не может его занять. Если это "
        "были не вы — ничего делать не нужно.\n",
    )
