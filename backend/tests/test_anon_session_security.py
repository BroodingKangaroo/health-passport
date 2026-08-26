"""
Security tests for the anonymous session principal (ISSUES.md #31):

- The anon cookie is HMAC-signed at issuance; unsigned/tampered values are
  never trusted as the authorization principal.
- Definition wire schemas no longer leak owner ``user_id``.
- The flowsheet excludes foreign (other-tenant) local definitions.
- Registration-time data migration only fires for a verifiably ours cookie.
"""
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.anon_session import sign_anon_id, verify_anon_cookie
from app.api.auth import router as auth_router
from app.api.entries import router as entries_router
from app.api.flowsheet import router as flowsheet_router
from app.api.timeline import router as timeline_router
from app.db.models import BiomarkerDefinition, BiomarkerReading, MedicalEntry, Patient
from app.db.session import Base, get_db
from config import ANONYMOUS_COOKIE_NAME
from tests.seed_data import TEST_ANON_ID, TEST_USER_ID, seed_test_db

TEST_DATABASE_URL = "sqlite:///:memory:"


@pytest.fixture(scope="function")
def sec_db_session():
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
async def cookie_client(sec_db_session):
    """Real auth dependencies (no principal override): the signed anon cookie
    is the ONLY credential, like production."""
    app = FastAPI()
    app.include_router(timeline_router)
    app.include_router(entries_router)
    app.include_router(flowsheet_router)
    app.include_router(auth_router)

    async def override_get_db():
        yield sec_db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _cookie_header(value: str) -> dict[str, str]:
    return {"Cookie": f"{ANONYMOUS_COOKIE_NAME}={value}"}


class TestSignVerify:
    def test_roundtrip(self):
        signed = sign_anon_id(TEST_ANON_ID)
        assert signed != TEST_ANON_ID  # value on the wire carries the signature
        assert verify_anon_cookie(signed) == TEST_ANON_ID

    def test_tampered_id_rejected(self):
        signed = sign_anon_id(TEST_ANON_ID)
        forged = signed.replace(TEST_ANON_ID, "anon-victim-id")
        assert verify_anon_cookie(forged) is None

    def test_tampered_signature_rejected(self):
        signed = sign_anon_id(TEST_ANON_ID)
        bad_sig = signed[:-1] + ("0" if signed[-1] != "0" else "1")
        assert verify_anon_cookie(bad_sig) is None

    def test_legacy_unsigned_value_rejected(self):
        # Pre-hardening cookies were the bare "anon-{hex}" id — never trust them.
        assert verify_anon_cookie(TEST_ANON_ID) is None

    def test_garbage_and_missing_rejected(self):
        assert verify_anon_cookie(None) is None
        assert verify_anon_cookie("") is None
        assert verify_anon_cookie("garbage") is None
        assert verify_anon_cookie(".abc") is None

    def test_registered_uuid_shape_rejected_even_if_signed(self):
        # Defense in depth: an anon principal must carry the anon- prefix, so
        # signing a Patient.id-shaped value can never authenticate as one.
        assert verify_anon_cookie(sign_anon_id("some-patient-uuid")) is None


class TestForgedCookieIsNotAPrincipal:
    async def test_forged_victim_uuid_reads_nothing(self, cookie_client, sec_db_session):
        """Setting the cookie to a victim's Patient.id must NOT grant their
        data: the request is treated as a brand-new anonymous session."""
        victim_entry = MedicalEntry(
            id="victim-entry",
            patient_id="victim-uuid",
            type="blood_test",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Victim Secret Panel",
            clinic="Clinic",
        )
        sec_db_session.add(victim_entry)
        sec_db_session.commit()

        resp = await cookie_client.get(
            "/api/timeline", headers=_cookie_header("victim-uuid")
        )

        assert resp.status_code == 200
        assert "victim-entry" not in [e["id"] for e in resp.json()["events"]]
        # A fresh SIGNED session was issued to replace the rejected value.
        minted = resp.cookies.get(ANONYMOUS_COOKIE_NAME)
        assert minted and verify_anon_cookie(minted) == minted.split(".")[0]

    async def test_forged_victim_uuid_writes_nowhere_near_victim(
        self, cookie_client, sec_db_session
    ):
        resp = await cookie_client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-11-15",
                "title": "Attacker Entry",
                "biomarkers": "[]",
            },
            headers=_cookie_header("victim-uuid"),
        )
        assert resp.status_code == 200

        victim_entries = (
            sec_db_session.query(MedicalEntry)
            .filter(MedicalEntry.patient_id == "victim-uuid")
            .all()
        )
        assert victim_entries == []
        # The new entry belongs to the freshly minted anon id, not the victim.
        new_owner = (
            sec_db_session.query(MedicalEntry)
            .filter(MedicalEntry.id == resp.json()["id"])
            .first()
            .patient_id
        )
        assert new_owner.startswith("anon-")
        assert new_owner != "victim-uuid"

    async def test_signed_session_survives_across_requests(self, cookie_client):
        """A legitimately issued signed cookie keeps working: create an entry,
        then read it back with the jar-stored cookie (no override)."""
        first = await cookie_client.get("/api/timeline")
        assert first.status_code == 200
        assert first.cookies.get(ANONYMOUS_COOKIE_NAME) is not None

        created = await cookie_client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-11-15",
                "title": "Anon Continuity",
                "biomarkers": "[]",
            },
        )
        assert created.status_code == 200
        entry_id = created.json()["id"]

        timeline = await cookie_client.get("/api/timeline")
        assert entry_id in [e["id"] for e in timeline.json()["events"]]


class TestRegisterMigrationUsesVerifiedCookie:
    def _seed_anon_data(self, db):
        db.add(MedicalEntry(
            id="anon-secret-entry",
            patient_id=TEST_ANON_ID,
            type="blood_test",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Anon Secret Entry",
            clinic="Clinic",
        ))
        db.commit()

    async def _register(self, client, email):
        return await client.post(
            "/api/auth/register",
            json={
                "name": "Newcomer",
                "email": email,
                "password": "password123",
                "dob": "1990-01-01",
                "gender": "Other",
                "migrate_data": True,
            },
        )

    async def test_legacy_unsigned_cookie_migrates_nothing(
        self, cookie_client, sec_db_session
    ):
        self._seed_anon_data(sec_db_session)
        resp = await self._register(cookie_client, "thief@example.com")
        assert resp.status_code == 201

        stolen = (
            sec_db_session.query(MedicalEntry)
            .filter(
                MedicalEntry.patient_id == resp.json()["id"],
                MedicalEntry.title == "Anon Secret Entry",
            )
            .all()
        )
        assert stolen == []

    async def test_valid_signed_cookie_still_migrates(
        self, cookie_client, sec_db_session
    ):
        self._seed_anon_data(sec_db_session)
        resp = await cookie_client.post(
            "/api/auth/register",
            json={
                "name": "Newcomer",
                "email": "honest@example.com",
                "password": "password123",
                "dob": "1990-01-01",
                "gender": "Other",
                "migrate_data": True,
            },
            headers=_cookie_header(sign_anon_id(TEST_ANON_ID)),
        )
        assert resp.status_code == 201
        copied = (
            sec_db_session.query(MedicalEntry)
            .filter(
                MedicalEntry.patient_id == resp.json()["id"],
                MedicalEntry.title == "Anon Secret Entry",
            )
            .all()
        )
        assert len(copied) == 1


class TestNoTenantLeakOnTheWire:
    async def test_definitions_carry_no_user_id(self, client):
        """Owner ids must never reach the wire (they complete the #31 attack
        chain). Timeline biomarker definitions are the main channel."""
        resp = await client.get("/api/timeline")
        assert resp.status_code == 200
        body = resp.json()
        assert body["biomarkers"], "seed data should produce biomarkers"
        serialized = str(body)
        assert '"user_id"' not in serialized

    async def test_flowsheet_excludes_foreign_local_defs(self, client, db_session):
        """A reading pointing at another tenant's local def must be dropped
        from the matrix instead of leaking the foreign definition."""
        other = Patient(
            id="foreign-owner",
            email="foreign@example.com",
            hashed_password="hashed",
            name="Foreign Owner",
            dob="1990-01-01",
            gender="Other",
            external_id="HP-FOR-0001",
        )
        foreign_def = BiomarkerDefinition(
            id="foreign-local-def",
            names={"en": "Foreign Analyte"},
            synonyms=None,
            category="Secret Category",
            reference=None,
            unit="x",
            scope="local",
            user_id="foreign-owner",
            reference_source="local",
        )
        entry = MedicalEntry(
            id="leak-entry",
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=datetime.fromisoformat("2026-01-05T00:00:00").replace(tzinfo=timezone.utc),
            title="Own Entry, Foreign Def Ref",
            clinic="Clinic",
        )
        reading = BiomarkerReading(
            entry_id="leak-entry",
            biomarker_id="foreign-local-def",
            value=1.0,
            status="normal",
        )
        db_session.add_all([other, foreign_def, entry, reading])
        db_session.commit()

        resp = await client.get("/api/flowsheet")
        assert resp.status_code == 200
        rows = [
            row
            for category in resp.json()["matrix"]
            for row in category["rows"]
        ]
        assert "foreign-local-def" not in [r["id"] for r in rows]
        assert "Foreign Analyte" not in [r["name"] for r in rows]
