"""
Tests for anonymous user sessions, usage limits, and data migration.
"""
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI, Request, Response
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.ai import router as ai_router
from app.api.auth import get_current_user_or_anon
from app.api.auth import router as auth_router
from app.api.biomarkers import router as biomarkers_router
from app.api.entries import router as entries_router
from app.api.flowsheet import router as flowsheet_router
from app.api.timeline import router as timeline_router
from app.api.usage_limits import router as usage_limits_router
from app.db.models import (
    BiomarkerDefinition,
    BiomarkerReading,
    InstrumentalData,
    MedicalEntry,
)
from app.db.session import Base, get_db
from app.services.data_migration import copy_anonymous_data, has_anonymous_data
from app.services.usage_limits import (
    check_and_record_ai_usage,
    check_and_record_storage_usage,
    get_limits,
    refund_ai_extraction,
)
from config import ANONYMOUS_LIMITS, REGISTERED_LIMITS
from tests.seed_data import (
    TEST_ANON_ID,
    TEST_USER_ID,
    seed_test_db,
)

TEST_DATABASE_URL = "sqlite:///:memory:"


@pytest.fixture(scope="function")
def anon_db_session():
    engine = create_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    seed_test_db(session)

    yield session

    session.close()
    Base.metadata.drop_all(bind=engine)


@pytest_asyncio.fixture
async def anon_client(anon_db_session):
    """Client that simulates an anonymous user via cookie."""

    app = FastAPI()
    app.include_router(timeline_router)
    app.include_router(flowsheet_router)
    app.include_router(entries_router)
    app.include_router(ai_router)
    app.include_router(biomarkers_router)
    app.include_router(auth_router)
    app.include_router(usage_limits_router)

    async def override_get_db():
        yield anon_db_session

    async def override_get_current_user_or_anon(request: Request, response: Response):
        # Simulate anonymous user with TEST_ANON_ID
        return (None, TEST_ANON_ID, True)

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user_or_anon] = override_get_current_user_or_anon

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


class TestAnonymousUserAccess:
    """Test that anonymous users can use the app."""

    async def test_anon_can_get_timeline(self, anon_client):
        """Anonymous user should be able to get timeline (empty initially)."""
        resp = await anon_client.get("/api/timeline")
        assert resp.status_code == 200
        data = resp.json()
        assert "events" in data
        assert "biomarkers" in data
        assert "visits" in data

    async def test_anon_can_get_flowsheet(self, anon_client):
        """Anonymous user should be able to get flowsheet."""
        resp = await anon_client.get("/api/flowsheet")
        assert resp.status_code == 200
        data = resp.json()
        assert "dates" in data
        assert "matrix" in data

    async def test_anon_can_create_entry(self, anon_client, anon_db_session):
        """Anonymous user should be able to create entries."""
        resp = await anon_client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-11-15",
                "clinic": "Test Lab",
                "title": "Anon Test",
                "biomarkers": "[]",
            },
        )
        assert resp.status_code == 200
        entry_id = resp.json()["id"]

        # Verify entry was saved with anon ID
        entry = anon_db_session.query(MedicalEntry).filter(
            MedicalEntry.id == entry_id
        ).first()
        assert entry is not None
        assert entry.patient_id == TEST_ANON_ID

    async def test_anon_can_get_usage_limits(self, anon_client):
        """Anonymous user should be able to get their usage limits."""
        resp = await anon_client.get("/api/usage/limits")
        assert resp.status_code == 200
        data = resp.json()
        assert data["is_anonymous"] is True
        assert data["ai_extraction_count"] == 0
        assert data["ai_extraction_limit"] == ANONYMOUS_LIMITS["ai_extractions"]
        assert data["total_upload_size_bytes"] == 0
        assert data["total_upload_limit_bytes"] == ANONYMOUS_LIMITS["storage_mb"] * 1024 * 1024


class TestUsageLimits:
    """Test usage limit enforcement."""

    def test_check_and_record_ai_usage_increments(self, anon_db_session):
        """Test that AI usage is tracked."""
        # First usage
        allowed, count, limit = check_and_record_ai_usage(
            anon_db_session, TEST_ANON_ID, is_anonymous=True
        )
        assert allowed is True
        assert count == 1
        assert limit == ANONYMOUS_LIMITS["ai_extractions"]

        # Second usage
        allowed, count, limit = check_and_record_ai_usage(
            anon_db_session, TEST_ANON_ID, is_anonymous=True
        )
        assert allowed is True
        assert count == 2

    def test_check_and_record_ai_usage_blocks_at_limit(self, anon_db_session):
        """Test that AI usage is blocked at limit."""
        # Use all allowed extractions
        for _ in range(ANONYMOUS_LIMITS["ai_extractions"]):
            check_and_record_ai_usage(anon_db_session, TEST_ANON_ID, is_anonymous=True)

        # Next attempt should be blocked
        allowed, count, _limit = check_and_record_ai_usage(
            anon_db_session, TEST_ANON_ID, is_anonymous=True
        )
        assert allowed is False
        assert count == ANONYMOUS_LIMITS["ai_extractions"]

    def test_refund_ai_extraction_decrements(self, anon_db_session):
        """A refund gives back exactly one charged extraction."""
        check_and_record_ai_usage(anon_db_session, TEST_ANON_ID, is_anonymous=True)
        check_and_record_ai_usage(anon_db_session, TEST_ANON_ID, is_anonymous=True)
        assert get_limits(anon_db_session, TEST_ANON_ID, True)["ai_extraction_count"] == 2

        refund_ai_extraction(anon_db_session, TEST_ANON_ID, is_anonymous=True)

        assert get_limits(anon_db_session, TEST_ANON_ID, True)["ai_extraction_count"] == 1

    def test_refund_ai_extraction_floors_at_zero(self, anon_db_session):
        """A refund can never drive the counter negative."""
        check_and_record_ai_usage(anon_db_session, TEST_ANON_ID, is_anonymous=True)
        refund_ai_extraction(anon_db_session, TEST_ANON_ID, is_anonymous=True)

        # Two refunds for one charge: the second is a no-op.
        refund_ai_extraction(anon_db_session, TEST_ANON_ID, is_anonymous=True)

        assert get_limits(anon_db_session, TEST_ANON_ID, True)["ai_extraction_count"] == 0

    def test_refund_ai_extraction_noop_without_row(self, anon_db_session):
        """Refunding a user with no UsageLimit row is a safe no-op."""
        refund_ai_extraction(anon_db_session, TEST_ANON_ID, is_anonymous=True)

        assert get_limits(anon_db_session, TEST_ANON_ID, True)["ai_extraction_count"] == 0

    def test_check_and_record_storage_usage(self, anon_db_session):
        """Test storage usage tracking."""
        # Add 1MB
        allowed, current, limit, remaining = check_and_record_storage_usage(
            anon_db_session, TEST_ANON_ID, 1024 * 1024, is_anonymous=True
        )
        assert allowed is True
        assert current == 1024 * 1024
        assert limit == ANONYMOUS_LIMITS["storage_mb"] * 1024 * 1024
        assert remaining == limit - current

    def test_check_and_record_storage_usage_blocks_at_limit(self, anon_db_session):
        """Test storage limit enforcement."""
        # Fill up storage
        max_bytes = ANONYMOUS_LIMITS["storage_mb"] * 1024 * 1024
        check_and_record_storage_usage(
            anon_db_session, TEST_ANON_ID, max_bytes, is_anonymous=True
        )

        # Next upload should be blocked
        allowed, current, _limit, remaining = check_and_record_storage_usage(
            anon_db_session, TEST_ANON_ID, 1, is_anonymous=True
        )
        assert allowed is False
        assert current == max_bytes
        assert remaining == 0

    def test_registered_user_has_higher_limits(self, anon_db_session):
        """Test that registered users have higher limits."""
        limits = get_limits(anon_db_session, TEST_USER_ID, is_anonymous=False)
        assert limits["ai_extraction_limit"] == REGISTERED_LIMITS["ai_extractions"]
        assert limits["total_upload_limit_bytes"] == REGISTERED_LIMITS["storage_mb"] * 1024 * 1024

        # Verify registered limits are higher than anonymous
        assert REGISTERED_LIMITS["ai_extractions"] > ANONYMOUS_LIMITS["ai_extractions"]
        assert REGISTERED_LIMITS["storage_mb"] > ANONYMOUS_LIMITS["storage_mb"]


class TestDataMigration:
    """Test data migration from anonymous to registered user."""

    def test_has_anonymous_data_false_when_empty(self, anon_db_session):
        """Test that has_anonymous_data returns False when no data."""
        assert has_anonymous_data(anon_db_session, TEST_ANON_ID) is False

    def test_has_anonymous_data_true_with_entries(self, anon_db_session):
        """Test that has_anonymous_data returns True when entries exist."""
        # Create an entry for anonymous user
        entry = MedicalEntry(
            id="anon-entry-1",
            patient_id=TEST_ANON_ID,
            type="blood_test",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Anon Test Entry",
            clinic="Test Clinic",
        )
        anon_db_session.add(entry)
        anon_db_session.commit()

        assert has_anonymous_data(anon_db_session, TEST_ANON_ID) is True

    def test_copy_anonymous_data_copies_entries(self, anon_db_session):
        """Test that copy_anonymous_data copies entries to new user."""
        # Create an entry for anonymous user
        entry = MedicalEntry(
            id="anon-entry-2",
            patient_id=TEST_ANON_ID,
            type="blood_test",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Anon Test Entry",
            clinic="Test Clinic",
        )
        anon_db_session.add(entry)
        anon_db_session.commit()

        # Copy to registered user
        summary = copy_anonymous_data(anon_db_session, TEST_ANON_ID, TEST_USER_ID)
        assert summary["entries_copied"] == 1

        # Verify entry exists for both anon and registered user
        anon_entries = anon_db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == TEST_ANON_ID
        ).all()
        assert len(anon_entries) == 1

        # Look for the copied entry by title (seed data already has entries for TEST_USER_ID)
        user_entries = anon_db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == TEST_USER_ID,
            MedicalEntry.title == "Anon Test Entry",
        ).all()
        assert len(user_entries) == 1

    def test_copy_anonymous_data_preserves_canonical_and_merge_fields(
        self, anon_db_session
    ):
        """Test that copied defs/readings keep canonical-unit and merge fields."""
        entry = MedicalEntry(
            id="anon-entry-fields",
            patient_id=TEST_ANON_ID,
            type="blood_test",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Anon Fields Entry",
            clinic="Test Clinic",
        )
        defn = BiomarkerDefinition(
            id="anon-def-fields",
            loinc_code="1234-5",
            names={"en": "Test Biomarker"},
            synonyms=None,
            category="chemistry",
            reference={"kind": "interval", "low": 1.0, "high": 2.0},
            unit="mg/dL",
            scope="local",
            user_id=TEST_ANON_ID,
            reference_source="local",
            canonical_unit="mmol/L",
            canonical_kind="linear",
            canonical_unit_inferred=True,
        )
        reading = BiomarkerReading(
            entry_id=entry.id,
            biomarker_id=defn.id,
            value=5.0,
            reference={"kind": "interval", "low": 1.0, "high": 2.0},
            status="high",
            original_name="Test Biomarker",
            original_value="5",
            original_unit="mg/dL",
            original_range="1 - 2",
            scale_function="factor:0.0555",
            needs_review=True,
            merged=True,
            merged_source={"title": "Later Test", "clinic": "Other Clinic"},
        )
        anon_db_session.add_all([entry, defn, reading])
        anon_db_session.commit()

        summary = copy_anonymous_data(anon_db_session, TEST_ANON_ID, TEST_USER_ID)
        assert summary["biomarker_defs_copied"] == 1
        assert summary["readings_copied"] == 1

        copied_defs = anon_db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.user_id == TEST_USER_ID
        ).all()
        assert len(copied_defs) == 1
        copied_def = copied_defs[0]
        assert copied_def.canonical_unit == "mmol/L"
        assert copied_def.canonical_kind == "linear"
        assert copied_def.canonical_unit_inferred is True

        copied_entries = anon_db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == TEST_USER_ID,
            MedicalEntry.title == "Anon Fields Entry",
        ).all()
        assert len(copied_entries) == 1
        copied_readings = anon_db_session.query(BiomarkerReading).filter(
            BiomarkerReading.entry_id == copied_entries[0].id
        ).all()
        assert len(copied_readings) == 1
        copied_reading = copied_readings[0]
        assert copied_reading.scale_function == "factor:0.0555"
        assert copied_reading.needs_review is True
        assert copied_reading.merged is True
        assert copied_reading.merged_source == {
            "title": "Later Test",
            "clinic": "Other Clinic",
        }

    def test_copy_anonymous_data_copies_instrumental_and_source_language(
        self, anon_db_session
    ):
        """InstrumentalData rows and MedicalEntry.source_language must survive
        the anon→registered migration (findings/conclusion + original-lang
        label are lost otherwise)."""
        entry = MedicalEntry(
            id="anon-entry-instr",
            patient_id=TEST_ANON_ID,
            type="instrumental",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Anon Instrumental Entry",
            clinic="Test Clinic",
            source_language="ru",
        )
        instrumental = InstrumentalData(
            entry_id=entry.id,
            modality="Ultrasound",
            findings="Желчный пузырь без особенностей",
            conclusion="Патологий не выявлено",
        )
        anon_db_session.add_all([entry, instrumental])
        anon_db_session.commit()

        summary = copy_anonymous_data(anon_db_session, TEST_ANON_ID, TEST_USER_ID)
        assert summary["instrumental_data_copied"] == 1

        copied_entries = anon_db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == TEST_USER_ID,
            MedicalEntry.title == "Anon Instrumental Entry",
        ).all()
        assert len(copied_entries) == 1
        copied_entry = copied_entries[0]
        assert copied_entry.source_language == "ru"

        copied_instrumental = anon_db_session.query(InstrumentalData).filter(
            InstrumentalData.entry_id == copied_entry.id
        ).all()
        assert len(copied_instrumental) == 1
        assert copied_instrumental[0].modality == "Ultrasound"
        assert copied_instrumental[0].findings == "Желчный пузырь без особенностей"
        assert copied_instrumental[0].conclusion == "Патологий не выявлено"

    async def test_register_declines_migration_keeps_data(self, anon_client, anon_db_session):
        """Test that registering with migrate_data=False does NOT copy anon data."""
        # Seed an anonymous entry
        entry = MedicalEntry(
            id="anon-entry-decline",
            patient_id=TEST_ANON_ID,
            type="blood_test",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Anon Decline Entry",
            clinic="Test Clinic",
        )
        anon_db_session.add(entry)
        anon_db_session.commit()

        resp = await anon_client.post(
            "/api/auth/register",
            json={
                "name": "Decliner",
                "email": "decliner@example.com",
                "password": "password123",
                "dob": "1990-01-01",
                "gender": "Male",
                "migrate_data": False,
            },
        )
        assert resp.status_code == 201

        new_user_id = resp.json()["id"]

        # Anon entry must remain untouched
        anon_entries = anon_db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == TEST_ANON_ID
        ).all()
        assert len(anon_entries) == 1

        # No entry should have been copied to the new user
        user_entries = anon_db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == new_user_id
        ).all()
        assert len(user_entries) == 0

    def test_anon_data_remains_after_copy(self, anon_db_session):
        """Test that anonymous data remains accessible after copy (not moved)."""
        # Create an entry for anonymous user
        entry = MedicalEntry(
            id="anon-entry-3",
            patient_id=TEST_ANON_ID,
            type="blood_test",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Anon Test Entry",
            clinic="Test Clinic",
        )
        anon_db_session.add(entry)
        anon_db_session.commit()

        # Copy to registered user
        copy_anonymous_data(anon_db_session, TEST_ANON_ID, TEST_USER_ID)

        # Anonymous data should still exist
        anon_entries = anon_db_session.query(MedicalEntry).filter(
            MedicalEntry.patient_id == TEST_ANON_ID
        ).all()
        assert len(anon_entries) == 1


class TestUsageLimitsEndpoint:
    """Test the usage limits API endpoint."""

    async def test_usage_limits_for_anonymous(self, anon_client):
        """Test getting usage limits as anonymous user."""
        resp = await anon_client.get("/api/usage/limits")
        assert resp.status_code == 200
        data = resp.json()
        assert data["is_anonymous"] is True
        assert data["ai_extraction_limit"] == ANONYMOUS_LIMITS["ai_extractions"]
        assert data["total_upload_limit_bytes"] == ANONYMOUS_LIMITS["storage_mb"] * 1024 * 1024

    async def test_usage_limits_after_ai_usage(self, anon_client, anon_db_session):
        """Test that usage limits reflect AI usage."""
        # Record some AI usage
        check_and_record_ai_usage(anon_db_session, TEST_ANON_ID, is_anonymous=True)
        check_and_record_ai_usage(anon_db_session, TEST_ANON_ID, is_anonymous=True)

        resp = await anon_client.get("/api/usage/limits")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ai_extraction_count"] == 2
