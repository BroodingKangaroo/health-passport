"""Delete E2E leftover entries ("clinic LIKE 'E2E %'") from a database.

Rewritten from a raw sqlite3 DELETE, which bypassed ORM cascades: it left
orphaned readings/attachment rows, stray files on disk and an overstated
storage counter. This version mirrors ``DELETE /api/entry``: snapshot the
attachment paths/sizes, ORM-delete the entries (cascading readings and
attachment rows), unlink files nothing else references, then refund each
affected user's storage counter (floored at zero).

Safety: the target DB must be passed explicitly via ``--db`` — the old script
silently also cleaned the real dev DB. Pass ``--yes`` for non-interactive runs.

Usage (from ``backend/``, venv active):

    python scripts/cleanup_e2e_data.py --db e2e_test.db --yes
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone

# Import the app package when invoked as a plain script from backend/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_SIZE_RE = re.compile(r"^([\d.]+)\s*(B|KB|MB|GB)?$")


def _parse_size(size_str: str) -> int:
    """Parse the human-readable ``Attachment.size`` (e.g. "312 KB") into
    bytes; 0 when missing or unparseable (same fuzzy fallback as the delete
    endpoint)."""
    if not size_str:
        return 0
    s = size_str.strip().upper().replace(",", ".")
    m = _SIZE_RE.match(s)
    if not m:
        return 0
    value = float(m.group(1))
    unit = m.group(2) or "B"
    if unit == "KB":
        return int(value * 1024)
    if unit == "MB":
        return int(value * 1024 * 1024)
    if unit == "GB":
        return int(value * 1024 * 1024 * 1024)
    return int(value)


def cleanup_database(db_path: str) -> dict:
    """Delete E2E leftovers from ``db_path``; returns
    ``{"entries": n, "freed_bytes": n}``."""
    from sqlalchemy import case, create_engine, update
    from sqlalchemy.orm import sessionmaker

    from app.db.models import Attachment as AttachmentModel
    from app.db.models import MedicalEntry, UsageLimit
    from app.db.session import configure_sqlite_engine
    from app.services.upload_cleanup import unlink_upload_file

    engine = create_engine(f"sqlite:///{db_path}")
    try:
        configure_sqlite_engine(engine)
        Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        db = Session()
        try:
            entries = (
                db.query(MedicalEntry)
                .filter(MedicalEntry.clinic.like("E2E %"))
                .all()
            )
            if not entries:
                return {"entries": 0, "freed_bytes": 0}

            # path -> (owner, parsed size), snapshotted BEFORE the cascade.
            files: dict[str, tuple[str, int]] = {}
            for e in entries:
                for a in e.attachments:
                    if a.file_path:
                        files[a.file_path] = (e.patient_id, _parse_size(a.size or ""))

            for e in entries:
                db.delete(e)
            db.commit()

            freed_bytes = 0
            refunds: dict[str, int] = {}
            for file_path, (user_id, parsed) in files.items():
                still_referenced = (
                    db.query(AttachmentModel)
                    .filter(AttachmentModel.file_path == file_path)
                    .first()
                )
                if still_referenced is not None:
                    continue  # shared with a surviving entry — keep the file
                on_disk = unlink_upload_file(file_path)
                freed = on_disk if on_disk > 0 else parsed
                freed_bytes += on_disk
                refunds[user_id] = refunds.get(user_id, 0) + freed

            # Floor the counter at zero (same CASE guard as the delete path).
            for user_id, refund in refunds.items():
                db.execute(
                    update(UsageLimit)
                    .where(UsageLimit.user_id == user_id)
                    .values(
                        total_upload_size_bytes=case(
                            (
                                UsageLimit.total_upload_size_bytes >= refund,
                                UsageLimit.total_upload_size_bytes - refund,
                            ),
                            else_=0,
                        ),
                        last_activity=datetime.now(timezone.utc),
                    )
                )
            db.commit()

            return {"entries": len(entries), "freed_bytes": freed_bytes}
        finally:
            db.close()
    finally:
        engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--db",
        required=True,
        help="SQLite database path to clean (e.g. e2e_test.db)",
    )
    parser.add_argument("--yes", action="store_true", help="skip confirmation")
    args = parser.parse_args(argv)

    db_path = os.path.abspath(os.path.expanduser(args.db))
    if not os.path.isfile(db_path):
        print(f"cleanup: {db_path} does not exist", file=sys.stderr)
        return 1
    if not args.yes:
        answer = input(f"Delete E2E entries from {db_path}? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("cleanup: aborted")
            return 1

    summary = cleanup_database(db_path)
    print(
        f"cleanup: deleted {summary['entries']} e2e entries "
        f"(freed {summary['freed_bytes']} bytes) from {db_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
