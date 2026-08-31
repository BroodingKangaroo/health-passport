"""ISSUES.md #37 — matcher local-definition ids are per-user.

- ``verify_or_create`` builds ``local-{user_id}-{md5(name)[:12]}`` (the same
  scheme as the manual-entry path in ``entries.py``) so two users extracting
  the same novel analyte get isolated definitions instead of colliding on a
  shared tenant-blind id.
- The startup data migration renames legacy ``local-{md5}`` rows that have an
  owner, remaps readings, and dedupes against an existing same-owner
  definition; NULL-user curated sentinel locals are untouched.
"""
import hashlib
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import BiomarkerDefinition, BiomarkerReading, MedicalEntry
from app.db.session import Base, migrate_local_definition_ids
from app.services.matcher.definitions import verify_or_create
from app.services.matcher.name_matching import _normalize_name

TEST_DATABASE_URL = "sqlite:///:memory:"


def _expected_id(user_id: str, name: str) -> str:
    digest = hashlib.md5(_normalize_name(name).encode()).hexdigest()[:12]
    return f"local-{user_id}-{digest}"


@pytest.fixture(scope="function")
def ids_db_session():
    engine = create_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    session = TestingSessionLocal()
    yield session
    session.close()
    Base.metadata.drop_all(bind=engine)


class TestVerifyOrCreatePerUserIds:
    def test_same_analyte_two_users_get_isolated_defs(self, ids_db_session):
        a = verify_or_create(
            ids_db_session, "Новый аналит", None, "user-a", grounded=False, force_local=True
        )
        b = verify_or_create(
            ids_db_session, "Новый аналит", None, "user-b", grounded=False, force_local=True
        )
        assert a.id == _expected_id("user-a", "Новый аналит")
        assert b.id == _expected_id("user-b", "Новый аналит")
        assert a.id != b.id
        assert a.user_id == "user-a"
        assert b.user_id == "user-b"

    def test_same_user_reuses_own_def(self, ids_db_session):
        first = verify_or_create(
            ids_db_session, "Новый аналит", None, "user-a", grounded=False, force_local=True
        )
        # Trailing punctuation normalizes to the same id.
        second = verify_or_create(
            ids_db_session, "Новый аналит.", None, "user-a", grounded=False, force_local=True
        )
        assert second.id == first.id
        assert ids_db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.user_id == "user-a"
        ).count() == 1

    def test_ownership_filter_never_returns_foreign_def(self, ids_db_session):
        from sqlalchemy.exc import IntegrityError

        # A foreign-owned row occupying the exact id this user's
        # verify_or_create would compute (only possible via tampering — the id
        # embeds the owner) must not be handed out: no reuse, fail loud.
        foreign_id = _expected_id("user-a", "Новый аналит")
        ids_db_session.add(BiomarkerDefinition(
            id=foreign_id,
            names={"en": "Новый аналит"},
            category="General",
            unit="",
            scope="local",
            user_id="someone-else",
        ))
        ids_db_session.commit()

        with pytest.raises(IntegrityError):
            verify_or_create(
                ids_db_session, "Новый аналит", None, "user-a", grounded=False, force_local=True
            )
        ids_db_session.rollback()
        rows = ids_db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == foreign_id
        ).all()
        assert len(rows) == 1
        assert rows[0].user_id == "someone-else"


def _entry_with_reading(session, reading_def_id: str, entry_id: str = "entry-1") -> None:
    session.add(MedicalEntry(
        id=entry_id,
        patient_id="patient-1",
        type="blood_test",
        date=datetime(2026, 5, 1, tzinfo=timezone.utc),
        title="Test Panel",
    ))
    session.add(BiomarkerReading(
        entry_id=entry_id,
        biomarker_id=reading_def_id,
        value=5.0,
        status="normal",
    ))


class TestLegacyIdMigration:
    def test_renames_legacy_row_and_remaps_readings(self, ids_db_session):
        ids_db_session.add(BiomarkerDefinition(
            id="local-abc123def456",
            names={"en": "Новый аналит"},
            category="General",
            unit="",
            scope="local",
            user_id="user-a",
        ))
        _entry_with_reading(ids_db_session, "local-abc123def456")
        ids_db_session.commit()

        migrate_local_definition_ids(ids_db_session.get_bind())
        ids_db_session.expire_all()

        renamed = ids_db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-user-a-abc123def456"
        ).one()
        assert renamed.user_id == "user-a"
        assert ids_db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-abc123def456"
        ).count() == 0
        reading = ids_db_session.query(BiomarkerReading).one()
        assert reading.biomarker_id == "local-user-a-abc123def456"

    def test_collision_remaps_readings_to_existing_def_and_deletes_legacy(
        self, ids_db_session
    ):
        ids_db_session.add(BiomarkerDefinition(
            id="local-abc123def456",
            names={"en": "Новый аналит"},
            category="General",
            unit="",
            scope="local",
            user_id="user-a",
            reference_source="pdf_extracted",
        ))
        ids_db_session.add(BiomarkerDefinition(
            id="local-user-a-abc123def456",
            names={"en": "Новый аналит"},
            category="General",
            unit="",
            scope="local",
            user_id="user-a",
            reference_source="manual",
        ))
        _entry_with_reading(ids_db_session, "local-abc123def456")
        ids_db_session.commit()

        migrate_local_definition_ids(ids_db_session.get_bind())
        ids_db_session.expire_all()

        assert ids_db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-abc123def456"
        ).count() == 0
        survivor = ids_db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-user-a-abc123def456"
        ).one()
        assert survivor.reference_source == "manual"
        reading = ids_db_session.query(BiomarkerReading).one()
        assert reading.biomarker_id == "local-user-a-abc123def456"

    def test_sentinel_and_null_user_locals_untouched_and_idempotent(self, ids_db_session):
        ids_db_session.add(BiomarkerDefinition(
            id="local-opisthorchis-igg",
            names={"en": "Opisthorchis IgG"},
            category="Microbiology",
            unit="",
            scope="local",
            user_id=None,
        ))
        _entry_with_reading(ids_db_session, "local-opisthorchis-igg", "entry-sentinel")
        ids_db_session.commit()

        migrate_local_definition_ids(ids_db_session.get_bind())
        migrate_local_definition_ids(ids_db_session.get_bind())
        ids_db_session.expire_all()

        sentinel = ids_db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-opisthorchis-igg"
        ).one()
        assert sentinel.user_id is None
        reading = ids_db_session.query(BiomarkerReading).filter(
            BiomarkerReading.entry_id == "entry-sentinel"
        ).one()
        assert reading.biomarker_id == "local-opisthorchis-igg"
