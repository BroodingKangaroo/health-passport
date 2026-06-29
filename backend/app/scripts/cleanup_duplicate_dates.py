"""One-time migration: convert legacy 'Mon DD, YYYY' dates to datetime and purge duplicates.

Usage:
    python -m app.scripts.cleanup_duplicate_dates

After running, the DB will have:
  - All MedicalEntry.date as ISO-8601 strings (SQLite) / datetimes (Python)
  - No two blood_test entries on the same calendar date (keeps newest by created_at)
"""

from collections import defaultdict
from datetime import datetime, timezone

from app.db.session import SessionLocal
from app.db.models import MedicalEntry


def cleanup():
    db = SessionLocal()
    try:
        entries = db.query(MedicalEntry).all()

        for e in entries:
            if isinstance(e.date, str):
                try:
                    dt = datetime.strptime(e.date, "%b %d, %Y").replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    continue
                e.date = dt

        db.flush()

        blood_tests = (
            db.query(MedicalEntry)
            .filter(MedicalEntry.type == "blood_test")
            .order_by(MedicalEntry.date)
            .all()
        )

        groups: dict[tuple, list[MedicalEntry]] = defaultdict(list)
        for e in blood_tests:
            groups[(e.date.year, e.date.month, e.date.day)].append(e)

        deleted = 0
        for date_key, entries in groups.items():
            if len(entries) > 1:
                entries.sort(key=lambda x: x.created_at or datetime.min.replace(tzinfo=timezone.utc))
                for dup in entries[:-1]:
                    db.delete(dup)
                    deleted += 1

        db.commit()
        print(f"Cleanup complete. Converted {len(entries)} dates, deleted {deleted} duplicates.")
    finally:
        db.close()


if __name__ == "__main__":
    cleanup()
