"""
Regression tests for ISSUES.md #40 (IntegrityError recovery destroyed pending
work): the definition/usage-limit INSERT recovery paths used a session-wide
``db.rollback()`` — with save_entry having already flushed the entry into the
same transaction, that rollback discarded it while the request kept going (a
later commit would then persist orphan rows, FK enforcement being off in
SQLite). Recovery now runs inside a SAVEPOINT (``begin_nested()``), so only
the failed INSERT is discarded.

A true concurrent-insert race is not observable under SQLite's transaction
snapshot (the second writer either blocks or the first insert simply
succeeds), so these tests simulate the losing INSERT with a flush that raises
IntegrityError and assert the *recovery semantics*: the earlier pending work
survives and the recovery query runs against the post-rollback session.
"""
from datetime import datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from app.db.models import MedicalEntry
from app.services.matcher.definitions import verify_or_create
from app.services.usage_limits import check_and_record_ai_usage
from tests.seed_data import TEST_USER_ID


@pytest.fixture
def session_with_pending_entry(db_session):
    """A session carrying flushed-but-uncommitted work, exactly like
    save_entry's session when _parse_biomarker_rows resolves definitions."""
    entry = MedicalEntry(
        id="entry-pending-40",
        patient_id=TEST_USER_ID,
        type="blood_test",
        date=datetime(2026, 3, 1, tzinfo=timezone.utc),
        title="Pending Entry #40",
        clinic="Clinic",
    )
    db_session.add(entry)
    db_session.flush()
    return db_session


def _boom_after_savepoint(session):
    """Make the session's first flush *inside* the next SAVEPOINT raise
    IntegrityError (simulating a lost concurrent INSERT), then restore normal
    flushing. begin_nested() itself flushes pending state as part of its
    snapshot, so the failure is armed only after the savepoint has begun —
    the failing call is exactly the INSERT flush under test."""
    orig_begin_nested = session.begin_nested
    orig_flush = session.flush
    state = {"armed": False}

    def begin_nested():
        nested = orig_begin_nested()
        state["armed"] = True
        return nested

    def flush(*args, **kwargs):
        if state["armed"]:
            state["armed"] = False
            raise IntegrityError(
                "INSERT INTO ...", {}, Exception("UNIQUE constraint failed")
            )
        return orig_flush(*args, **kwargs)

    session.begin_nested = begin_nested
    session.flush = flush


class TestVerifyOrCreateSavepoint:
    def test_pending_batch_survives_failed_insert(self, session_with_pending_entry):
        db = session_with_pending_entry
        # Earlier definition of the same batch, already flushed (uncommitted).
        earlier = verify_or_create(
            db, "Earlier Analyte", None, TEST_USER_ID, grounded=False, force_local=True
        )

        _boom_after_savepoint(db)
        # The losing INSERT: recovery finds no pre-existing row and re-raises,
        # but the earlier batch work must survive the savepoint rollback.
        with pytest.raises(IntegrityError):
            verify_or_create(
                db, "Race Analyte", None, TEST_USER_ID, grounded=False, force_local=True
            )

        assert earlier in db
        db.commit()
        assert db.query(MedicalEntry).filter(
            MedicalEntry.id == "entry-pending-40"
        ).first() is not None
        assert db.query(MedicalEntry).filter(
            MedicalEntry.patient_id == TEST_USER_ID,
            MedicalEntry.title == "Pending Entry #40",
        ).count() == 1

    def test_recovery_returns_concurrent_row(self, session_with_pending_entry):
        """When a row with the same id exists post-rollback, recovery returns
        it instead of raising."""
        db = session_with_pending_entry
        import hashlib

        from app.db.models import BiomarkerDefinition
        from app.services.matcher.name_matching import _normalize_name

        target_name = "Concurrent Analyte"
        target_id = (
            f"local-{TEST_USER_ID}-"
            f"{hashlib.md5(_normalize_name(target_name).encode()).hexdigest()[:12]}"
        )
        # The concurrent winner's row, visible to a post-rollback re-query
        # (raw INSERT so the session's identity map does not pre-empt it).
        db.execute(
            BiomarkerDefinition.__table__.insert().values(
                id=target_id,
                names={"en": target_name},
                synonyms=[target_name],
                category="General",
                unit="",
                scope="local",
                user_id=TEST_USER_ID,
            )
        )

        _boom_after_savepoint(db)
        resolved = verify_or_create(
            db, target_name, None, TEST_USER_ID, grounded=False, force_local=True
        )
        assert resolved.id == target_id
        db.commit()


class TestResolveDefinitionSavepoint:
    def test_pending_entry_survives_failed_def_insert(self, session_with_pending_entry):
        from app.api.entries import _resolve_definition

        db = session_with_pending_entry
        _boom_after_savepoint(db)
        # No pre-existing row: recovery leaves defn None (the caller's parse
        # step would reject the row), but the flushed entry must survive.
        defn = _resolve_definition(db, TEST_USER_ID, "Race Analyte", None, "General")
        assert defn is None
        db.commit()
        assert db.query(MedicalEntry).filter(
            MedicalEntry.id == "entry-pending-40"
        ).first() is not None


class TestUsageLimitSavepoint:
    def test_ai_usage_recovery_preserves_pending(self, session_with_pending_entry):
        db = session_with_pending_entry
        _boom_after_savepoint(db)
        allowed, _count, _limit = check_and_record_ai_usage(
            db, TEST_USER_ID, is_anonymous=True
        )
        assert allowed is True
        # The recovery retry UPDATE found no row (none exists in this test's
        # DB) — the important assertion is that the flushed entry survived.
        db.commit()
        assert db.query(MedicalEntry).filter(
            MedicalEntry.id == "entry-pending-40"
        ).first() is not None

    def test_ai_usage_recovery_preserves_pending_commit_false(
        self, session_with_pending_entry
    ):
        db = session_with_pending_entry
        _boom_after_savepoint(db)
        allowed, _count, _limit = check_and_record_ai_usage(
            db, TEST_USER_ID, is_anonymous=True, commit=False
        )
        assert allowed is True
        assert db.query(MedicalEntry).filter(
            MedicalEntry.id == "entry-pending-40"
        ).first() is not None
        db.commit()

    def test_storage_recovery_preserves_pending(self, session_with_pending_entry):
        from app.services.usage_limits import check_and_record_storage_usage

        db = session_with_pending_entry
        _boom_after_savepoint(db)
        allowed, _total, _limit, _remaining = check_and_record_storage_usage(
            db, TEST_USER_ID, 1024, is_anonymous=True, commit=False
        )
        assert allowed is True
        assert db.query(MedicalEntry).filter(
            MedicalEntry.id == "entry-pending-40"
        ).first() is not None
        db.commit()
