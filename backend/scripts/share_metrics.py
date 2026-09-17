"""Reader for the share-link funnel (roadmap 1.1, Stage 4 S17).

Stages 2 and 3 deliberately made the funnel write-only: `share_funnel_events`
records sender actions, `share_links` records opens, and no application code
reads either. That was the right call while the feature was being built, and
it is the wrong call now — every Stage 5 decision is supposed to be made on
evidence, and this is where the evidence is.

This is OPS TOOLING, not a feature. There is no endpoint, no admin page and no
new table: it prints what the rows already hold. It carries no recipient
identity because none was ever stored — a link knows how often it was opened,
never by whom.

Usage (from backend/):
    venv/bin/python scripts/share_metrics.py
    venv/bin/python scripts/share_metrics.py --json
    venv/bin/python scripts/share_metrics.py --since 30

Read-only: it opens the session, runs SELECTs and prints. It never writes, so
running it against a live DB is safe.
"""
from __future__ import annotations

# ruff: noqa: E402 -- load_dotenv() must run before importing app.db.session,
# which reads DATABASE_URL from the environment at import time.
import argparse
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv()

from app.db.models import ShareFunnelEvent, ShareLink
from app.db.session import SessionLocal
from app.services.share_links import (
    FUNNEL_CTA_CLICKED,
    FUNNEL_LINK_CREATED,
    FUNNEL_LINK_REVOKED,
)

logger = logging.getLogger("share_metrics")


def _rate(numerator: int, denominator: int) -> float | None:
    """A share of a whole, or None when there is nothing to divide by.

    None rather than 0.0 on purpose: "no links exist" and "no link was ever
    opened" are different facts, and printing 0% for the first one would make
    a feature nobody has used look like a feature nobody wants."""
    if denominator <= 0:
        return None
    return round(numerator / denominator, 4)


def collect(db, since_days: int | None = None) -> dict[str, Any]:
    """Every number the funnel rows and the link rows already hold."""
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=since_days)
        if since_days is not None
        else None
    )

    links = db.query(ShareLink)
    if cutoff is not None:
        links = links.filter(ShareLink.created_at >= cutoff)
    rows = links.all()

    events = db.query(ShareFunnelEvent)
    if cutoff is not None:
        events = events.filter(ShareFunnelEvent.created_at >= cutoff)
    created_events = events.filter(ShareFunnelEvent.event == FUNNEL_LINK_CREATED).count()
    revoked_events = events.filter(ShareFunnelEvent.event == FUNNEL_LINK_REVOKED).count()
    cta_clicks = events.filter(ShareFunnelEvent.event == FUNNEL_CTA_CLICKED).count()

    # Sender flags come off the funnel rows, so the split survives even if a
    # link row is later deleted by the account-deletion cascade. They are
    # built from `events` rather than a fresh query so `--since` applies to
    # them too -- the splits used to ignore the window, which could print more
    # registered creations than total creations (Stage 4 review, F5).
    def _created_split(is_anonymous: bool) -> int:
        return (
            events.filter(
                ShareFunnelEvent.event == FUNNEL_LINK_CREATED,
                ShareFunnelEvent.is_anonymous.is_(is_anonymous),
            ).count()
        )

    anon_created = _created_split(True)
    registered_created = _created_split(False)

    now = datetime.now(timezone.utc)
    total_links = len(rows)
    opened = [row for row in rows if (row.open_count or 0) > 0]
    repeat = [row for row in rows if (row.open_count or 0) > 1]
    # "Came back after new data": the debounced open stamps the record
    # watermark each time, so the comparison is between two stored values.
    returned_after_new_data = [
        row
        for row in rows
        if (row.first_open_record_at is not None)
        and (row.last_open_record_at is not None)
        and row.last_open_record_at > row.first_open_record_at
    ]
    active = [
        row
        for row in rows
        if row.revoked_at is None
        and (row.expires_at.replace(tzinfo=timezone.utc) if row.expires_at.tzinfo is None else row.expires_at) > now
    ]
    protected = [row for row in rows if row.passcode_hash]

    return {
        "window_days": since_days,
        "links": {
            "total": total_links,
            "active": len(active),
            "opened_at_least_once": len(opened),
            "repeat_opens": len(repeat),
            "returned_after_new_data": len(returned_after_new_data),
            "protected": len(protected),
            "total_opens": sum((row.open_count or 0) for row in rows),
        },
        "funnel": {
            "link_created": created_events,
            "link_created_anonymous": anon_created,
            "link_created_registered": registered_created,
            "link_revoked": revoked_events,
            "cta_clicked": cta_clicks,
        },
        "rates": {
            "open_rate": _rate(len(opened), total_links),
            "reopen_rate": _rate(len(repeat), total_links),
            "revoke_rate": _rate(revoked_events, created_events),
            # Clicks per OPENED link: the CTA is tokenless by design, so it can
            # never be attributed to one link — only to the population of links
            # that were read at all.
            "cta_per_opened_link": _rate(cta_clicks, len(opened)),
        },
    }


def _print_human(report: dict[str, Any]) -> None:
    window = report["window_days"]
    scope = f"the last {window} days" if window else "all time"
    print(f"Share-link funnel ({scope})")
    print()
    links = report["links"]
    print("Links")
    print(f"  created (rows still present) : {links['total']}")
    print(f"  active right now             : {links['active']}")
    print(f"  protected by passcode        : {links['protected']}")
    print(f"  opened at least once         : {links['opened_at_least_once']}")
    print(f"  opened more than once        : {links['repeat_opens']}")
    print(f"  opened after new data        : {links['returned_after_new_data']}")
    print(f"  total opens (debounced)      : {links['total_opens']}")
    print()
    funnel = report["funnel"]
    print("Funnel events")
    print(f"  link_created                 : {funnel['link_created']}")
    print(f"    of which anonymous         : {funnel['link_created_anonymous']}")
    print(f"    of which registered        : {funnel['link_created_registered']}")
    print(f"  link_revoked                 : {funnel['link_revoked']}")
    print(f"  cta_clicked (recipients)     : {funnel['cta_clicked']}")
    print()
    print("Derived")
    for name, value in report["rates"].items():
        print(f"  {name:28s} : {'n/a' if value is None else format(value, '.1%')}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Print the share-link funnel (read-only ops tooling).",
    )
    parser.add_argument(
        "--since",
        type=int,
        default=None,
        metavar="DAYS",
        help="Only count rows newer than N days (default: all time).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the report as JSON instead of a human table.",
    )
    args = parser.parse_args(argv)
    if args.since is not None and args.since <= 0:
        parser.error("--since must be a positive number of days")

    db = SessionLocal()
    try:
        report = collect(db, args.since)
    finally:
        db.close()

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        _print_human(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
