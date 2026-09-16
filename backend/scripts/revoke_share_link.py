"""Ops takedown for a single reported share link (roadmap 1.1, Stage 2 S7).

A share link's raw token is stored only as SHA-256, so a reported link cannot
be found by looking it up as text: this script hashes the token the reporter
supplied and revokes exactly that row. There is deliberately no admin console
and no link-list endpoint - support handles one reported link and nothing else,
which is also why the script never prints the token.

Usage (from backend/):
    venv/bin/python scripts/revoke_share_link.py hp_...
    printf '%s' "$TOKEN" | venv/bin/python scripts/revoke_share_link.py -

Exit codes: 0 revoked (or already revoked), 1 unknown token, 2 failure or bad
usage. The revocation is committed before the summary is printed, so a failure
surfaces as a non-zero exit rather than a silent "done".
"""
from __future__ import annotations

# ruff: noqa: E402 -- load_dotenv() must run before importing app.db.session,
# which reads DATABASE_URL from the environment at import time.
import argparse
import logging
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv()

from app.db.models import ShareLink
from app.db.session import SessionLocal, init_db
from app.services.share_links import hash_token

logger = logging.getLogger("revoke_share_link")


def _read_token(arg: str) -> str:
    """The token from argv, or from stdin when the argument is ``-``.

    Stdin exists so a token read out of an incident ticket never lands in the
    shell history or the process table."""
    raw = sys.stdin.read() if arg == "-" else arg
    return raw.strip()


def revoke(token: str) -> int:
    """Hash ``token``, revoke the matching link and report. Returns an exit
    code; nothing about the token itself is ever printed."""
    digest = hash_token(token)
    now = datetime.now(timezone.utc)
    db = SessionLocal()
    try:
        link = db.query(ShareLink).filter(ShareLink.token_hash == digest).first()
        if link is None:
            logger.error("No share link matches that token - nothing revoked.")
            return 1
        already = link.revoked_at is not None
        if not already:
            link.revoked_at = now
            db.commit()
        state = (
            f"was already revoked at {link.revoked_at.isoformat()}"
            if already
            else f"revoked at {now.isoformat()}"
        )
        logger.info(
            "Share link %s (%s, owner %s): %s",
            link.id,
            "anonymous" if link.is_anonymous else "registered",
            link.owner_id,
            state,
        )
        return 0
    except Exception:
        db.rollback()
        logger.exception("Revocation failed - no change was made.")
        return 2
    finally:
        db.close()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Revoke one share link by its raw token (a reported link).",
    )
    parser.add_argument(
        "token",
        help="The raw hp_ token from the report, or - to read it from stdin.",
    )
    args = parser.parse_args(argv)

    token = _read_token(args.token)
    if not token:
        parser.error("the token is empty")
    # Idempotent: the table must exist before the lookup, so a takedown against
    # a freshly-created DB fails as "unknown token" rather than a stack trace.
    init_db()
    return revoke(token)


if __name__ == "__main__":
    raise SystemExit(main())
