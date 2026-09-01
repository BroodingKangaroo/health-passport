"""
Regression tests for ISSUES.md #59 (N+1 query patterns): the timeline,
flowsheet, and by-date endpoints used one query per entry for readings and
lazily loaded `entry.attachments` per row — correct but O(N). The refactored
endpoints use a fixed number of batched/eager queries regardless of how many
entries or biomarkers exist.

These tests seed extra blood tests + distinct biomarkers and assert the
SELECT count stays under a constant bound (the old pattern's count grows with
the seeded volume and would exceed it).
"""
from datetime import datetime, timezone

from sqlalchemy import event

from app.db.models import BiomarkerDefinition, BiomarkerReading, MedicalEntry
from tests.seed_data import TEST_USER_ID


def _seed_extra_blood_tests(db_session, count: int = 5, on_date=None):
    """`count` extra blood tests with one reading each on 3 NEW global defs —
    enough that the old per-entry + per-biomarker pattern's query count grows
    well past the constant bounds asserted below. With ``on_date`` all
    entries land on that single date (for the by-date endpoint's per-entry
    queries to accumulate)."""
    base = on_date or datetime(2026, 5, 1, tzinfo=timezone.utc)
    for i in range(count):
        db_session.add(MedicalEntry(
            id=f"nq-entry-{i}",
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=base,
            title=f"N+1 Panel {i}",
            clinic="Clinic",
        ))
        db_session.add(BiomarkerReading(
            entry_id=f"nq-entry-{i}",
            biomarker_id=f"test-bid-{i % 3}",
            value=1.0 + i,
            status="normal",
        ))
    db_session.add_all([
        BiomarkerDefinition(
            id=f"test-bid-{i}",
            names={"en": f"N+1 Analyte {i}"},
            synonyms=[],
            category="General",
            reference=None,
            unit="x",
            scope="global",
            common_rank=500 + i,
        )
        for i in range(3)
    ])
    db_session.commit()


class TestTimelineQueryBoundedness:
    async def test_timeline_selects_bounded(self, client, db_session):
        _seed_extra_blood_tests(db_session, count=5)
        statements: list[str] = []

        def hook(conn, cursor, statement, parameters, context, executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(db_session.bind, "before_cursor_execute", hook)
        try:
            resp = await client.get("/api/timeline")
        finally:
            event.remove(db_session.bind, "before_cursor_execute", hook)
        assert resp.status_code == 200
        # Old pattern: per-entry readings + per-biomarker history + lazy
        # attachment loads each add queries as entries/biomarkers grow.
        assert 0 < len(statements) <= 20, (
            f"timeline issued {len(statements)} SELECTs — N+1 regression?"
        )

    async def test_flowsheet_selects_bounded(self, client, db_session):
        _seed_extra_blood_tests(db_session, count=5)
        statements: list[str] = []

        def hook(conn, cursor, statement, parameters, context, executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(db_session.bind, "before_cursor_execute", hook)
        try:
            resp = await client.get("/api/flowsheet")
        finally:
            event.remove(db_session.bind, "before_cursor_execute", hook)
        assert resp.status_code == 200
        # Old pattern added one readings query per blood-test entry.
        assert 0 < len(statements) <= 12, (
            f"flowsheet issued {len(statements)} SELECTs — N+1 regression?"
        )

    async def test_by_date_selects_bounded(self, client, db_session):
        _seed_extra_blood_tests(db_session, count=5, on_date=datetime(2026, 6, 1, tzinfo=timezone.utc))
        statements: list[str] = []

        def hook(conn, cursor, statement, parameters, context, executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(db_session.bind, "before_cursor_execute", hook)
        try:
            resp = await client.get(
                "/api/entries/by-date", params={"date": "2026-06-01"}
            )
        finally:
            event.remove(db_session.bind, "before_cursor_execute", hook)
        assert resp.status_code == 200
        # Old pattern: one readings + one definitions query PER entry on the
        # date (≥ 1 + 2×6 with the seeded extras alone).
        assert 0 < len(statements) <= 8, (
            f"by-date issued {len(statements)} SELECTs — N+1 regression?"
        )
