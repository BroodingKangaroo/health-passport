"""
Email delivery for HealthPassport (password reset).

Uses stdlib ``smtplib`` with SMTP_* env settings from ``config``. When SMTP
is not configured (local dev), the reset link is logged instead so the flow
remains testable end-to-end without a mail server.
"""

import logging
import smtplib
from email.message import EmailMessage

from config import (
    SMTP_ENABLED,
    SMTP_FROM,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_TLS,
    SMTP_USER,
)

logger = logging.getLogger(__name__)


def send_reset_email(email: str, reset_url: str) -> None:
    """Email a password-reset link, or log it when SMTP is not configured."""
    if not SMTP_ENABLED:
        logger.warning(
            "SMTP not configured — password reset link for %s: %s",
            email,
            reset_url,
        )
        return

    msg = EmailMessage()
    msg["Subject"] = "Reset your HealthPassport password"
    msg["From"] = SMTP_FROM
    msg["To"] = email
    msg.set_content(
        "You requested a password reset for your HealthPassport account.\n\n"
        "Open the link below to choose a new password (valid for 30 minutes):\n\n"
        f"{reset_url}\n\n"
        "If you didn't request this, you can safely ignore this email.\n"
    )

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
        if SMTP_TLS:
            server.starttls()
        if SMTP_USER:
            server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(msg)
