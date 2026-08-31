"""GET /api/export (ISSUES.md F1): full-data export endpoint.

Covers the versioned JSON envelope, the CSV readings table, tenant
isolation (registered + anonymous principals), local-definition export,
invalid-format 400 (localized), and the no-quota-charge guarantee.
"""

from datetime import datetime, timezone

import pytest
from fastapi import FastAPI, Request, Response
from httpx import ASGITransport, AsyncClient

from app.api.account import _CSV_COLUMNS, EXPORT_FORMAT_VERSION
from app.api.account import router as account_router
from app.api.auth import get_current_user_or_anon
from app.db.models import (
    BiomarkerDefinition,
    BiomarkerReading,
    MedicalEntry,
    UsageLimit,
)
from app.db.session import get_db
from app.i18n import LocaleMiddleware
from config import ANONYMOUS_LIMITS, REGISTERED_LIMITS
from tests.seed_data import TEST_ANON_ID, TEST_USER_EMAIL, TEST_USER_ID


def _make_client(db_session, principal):
    """Export-capable client for an explicit principal
    (user_row_or_None, user_id, is_anonymous)."""
    app = FastAPI()
    app.include_router(account_router)
    app.add_middleware(LocaleMiddleware)

    async def override_get_db():
        yield db_session

    async def override_principal(request: Request, response: Response):
        return principal

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user_or_anon] = override_principal

    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


def _add_local_def(db_session, defn_id: str, user_id: str, name: str):
    db_session.add(BiomarkerDefinition(
        id=defn_id,
        names={"en": name},
        category="Custom",
        reference={"kind": "interval", "low": 0.0, "high": 10.0},
        unit="x",
        scope="local",
        user_id=user_id,
        reference_source="local",
    ))


def _reading_count(db_session, patient_id: str) -> int:
    return (
        db_session.query(BiomarkerReading)
        .join(MedicalEntry, BiomarkerReading.entry_id == MedicalEntry.id)
        .filter(MedicalEntry.patient_id == patient_id)
        .count()
    )


class TestExportJSON:
    async def test_envelope_shape(self, client):
        resp = await client.get("/api/export")
        assert resp.status_code == 200
        data = resp.json()
        assert data["format"] == EXPORT_FORMAT_VERSION
        assert data["exported_at"]
        assert data["account"]["email"] == TEST_USER_EMAIL
        assert data["account"]["is_anonymous"] is False
        assert data["usage"]["is_anonymous"] is False
        assert data["usage"]["ai_extraction_limit"] == REGISTERED_LIMITS["ai_extractions"]
        assert set(data.keys()) == {
            "format", "exported_at", "account", "usage", "entries", "biomarker_definitions",
        }

    async def test_entries_exported_with_nested_payloads(self, client):
        resp = await client.get("/api/export")
        data = resp.json()
        # Seeded world: 9 blood tests + 3 doctor visits + 1 procedure.
        assert len(data["entries"]) == 13

        by_id = {e["id"]: e for e in data["entries"]}
        blood = by_id["blood-feb"]
        for key in (
            "id", "type", "date", "title", "subtitle", "category", "status",
            "clinic", "notes", "source_language", "created_at",
            "biomarker_readings", "attachments", "visit_data", "instrumental_data",
        ):
            assert key in blood
        assert blood["type"] == "blood_test"
        assert blood["visit_data"] is None
        assert blood["instrumental_data"] is None
        assert blood["attachments"][0]["id"] == "feb-lab"

        # Readings carry every documented column.
        wbc = next(r for r in blood["biomarker_readings"] if r["biomarker_id"] == "wbc")
        for key in (
            "id", "biomarker_id", "value", "value_text", "reference", "status",
            "original_name", "original_value", "original_unit", "original_range",
            "scale_function", "needs_review", "merged", "merged_source",
        ):
            assert key in wbc
        assert wbc["value"] == 5.2
        assert wbc["status"] == "normal"
        assert wbc["reference"] == {"kind": "interval", "low": 4.0, "high": 11.0}
        assert wbc["merged"] is False

        visit = by_id["cardio"]
        assert visit["visit_data"]["specialty"] == "Cardiology Follow-up"
        assert len(visit["visit_data"]["prescriptions"]) == 1

    async def test_local_definitions_only(self, client, db_session):
        _add_local_def(db_session, "local-custom-a", TEST_USER_ID, "My Custom Marker")
        db_session.add(BiomarkerReading(
            entry_id="blood-feb",
            biomarker_id="local-custom-a",
            value=5.0,
            reference={"kind": "interval", "low": 0.0, "high": 10.0},
            status="normal",
        ))
        db_session.commit()

        resp = await client.get("/api/export")
        data = resp.json()
        ids = [d["id"] for d in data["biomarker_definitions"]]
        assert ids == ["local-custom-a"]
        assert data["biomarker_definitions"][0]["names"]["en"] == "My Custom Marker"
        # Globals are LOINC-dictionary-derivable and never exported.
        assert "wbc" not in ids

        entry = next(e for e in data["entries"] if e["id"] == "blood-feb")
        assert any(
            r["biomarker_id"] == "local-custom-a" and r["value"] == 5.0
            for r in entry["biomarker_readings"]
        )

    async def test_export_does_not_charge_quota(self, client, db_session):
        assert db_session.query(UsageLimit).count() == 0
        await client.get("/api/export")
        await client.get("/api/export?format=csv")
        # Export is not AI usage: no counter row is created or incremented.
        assert db_session.query(UsageLimit).count() == 0


class TestExportTenantIsolation:
    async def test_second_user_sees_only_their_rows(self, client, db_session):
        from app.auth import create_user

        _add_local_def(db_session, "local-custom-a", TEST_USER_ID, "Marker A")
        user_b = create_user(
            db_session, "user-b@example.com", "password123", "User B", "1980-02-02", "Other",
        )
        _add_local_def(db_session, "local-custom-b", user_b.id, "Marker B")
        db_session.add(MedicalEntry(
            id="userb-entry",
            patient_id=user_b.id,
            type="blood_test",
            date=datetime(2024, 3, 1, tzinfo=timezone.utc),
            title="User B Panel",
        ))
        db_session.add(BiomarkerReading(
            entry_id="userb-entry",
            biomarker_id="wbc",
            value=7.0,
            reference={"kind": "interval", "low": 4.0, "high": 11.0},
            status="normal",
        ))
        db_session.commit()

        # The default `client` is TEST_USER: none of user B's rows leak.
        data = (await client.get("/api/export")).json()
        assert {e["id"] for e in data["entries"]}.isdisjoint({"userb-entry"})
        assert [d["id"] for d in data["biomarker_definitions"]] == ["local-custom-a"]

        async with _make_client(db_session, (user_b, user_b.id, False)) as client_b:
            data_b = (await client_b.get("/api/export")).json()
        assert [e["id"] for e in data_b["entries"]] == ["userb-entry"]
        assert data_b["account"]["email"] == "user-b@example.com"
        assert [d["id"] for d in data_b["biomarker_definitions"]] == ["local-custom-b"]
        assert data_b["entries"][0]["biomarker_readings"][0]["value"] == 7.0

    async def test_anonymous_principal_sees_only_own_data(self, db_session):
        db_session.add(MedicalEntry(
            id="anon-entry",
            patient_id=TEST_ANON_ID,
            type="blood_test",
            date=datetime(2024, 4, 1, tzinfo=timezone.utc),
            title="Anon Panel",
        ))
        db_session.commit()

        async with _make_client(db_session, (None, TEST_ANON_ID, True)) as anon:
            resp = await anon.get("/api/export")
        assert resp.status_code == 200
        data = resp.json()
        assert data["account"] == {"id": TEST_ANON_ID, "is_anonymous": True}
        assert [e["id"] for e in data["entries"]] == ["anon-entry"]
        assert data["biomarker_definitions"] == []
        assert data["usage"]["ai_extraction_limit"] == ANONYMOUS_LIMITS["ai_extractions"]

    async def test_empty_account_exports_empty_lists(self, db_session):
        async with _make_client(db_session, (None, "anon-empty", True)) as anon:
            resp = await anon.get("/api/export")
        data = resp.json()
        assert resp.status_code == 200
        assert data["entries"] == []
        assert data["biomarker_definitions"] == []
        assert data["usage"]["ai_extraction_count"] == 0


class TestExportCSV:
    async def test_csv_headers_rows_and_attachment(self, client, db_session):
        resp = await client.get("/api/export?format=csv")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/csv")
        assert "attachment" in resp.headers["content-disposition"]
        assert "healthpassport-readings-" in resp.headers["content-disposition"]

        lines = resp.text.splitlines()
        # UTF-8 BOM so Excel opens Cyrillic cells correctly.
        assert resp.content.startswith(b"\xef\xbb\xbf")
        header = lines[0].lstrip("\ufeff").split(",")
        assert header == _CSV_COLUMNS
        assert len(lines) - 1 == _reading_count(db_session, TEST_USER_ID)

    async def test_csv_row_content(self, client, db_session):
        _add_local_def(db_session, "local-custom-a", TEST_USER_ID, "My Custom Marker")
        db_session.add(BiomarkerReading(
            entry_id="blood-feb",
            biomarker_id="local-custom-a",
            value=5.0,
            reference={"kind": "interval", "low": 0.0, "high": 10.0},
            status="normal",
            original_name="Мой маркер",
        ))
        db_session.commit()

        import csv as csv_mod
        import io

        resp = await client.get("/api/export?format=csv")
        rows = list(csv_mod.reader(io.StringIO(resp.text.lstrip("\ufeff"))))
        header, data_rows = rows[0], rows[1:]

        row = next(r for r in data_rows if r[header.index("biomarker_id")] == "local-custom-a")
        assert row[header.index("name")] == "My Custom Marker"
        assert row[header.index("original_name")] == "Мой маркер"
        assert row[header.index("value")] == "5.0"
        assert row[header.index("unit")] == "x"
        assert row[header.index("status")] == "normal"
        assert row[header.index("reference_kind")] == "interval"
        assert row[header.index("reference_low")] == "0.0"
        assert row[header.index("reference_high")] == "10.0"

        wbc = next(r for r in data_rows if r[header.index("biomarker_id")] == "wbc")
        assert wbc[header.index("name")] == "WBC"
        assert wbc[header.index("unit")] == "K/µL"
        assert wbc[header.index("reference_expected")] == ""

    async def test_csv_zero_bound_is_preserved(self, client, db_session):
        # A 0.0 reference bound must survive (never collapsed to "" by falsiness).
        db_session.add(BiomarkerDefinition(
            id="ldl-zero",
            names={"en": "LDL Cholesterol"},
            category="Lipid Panel",
            reference={"kind": "interval", "low": 0.0, "high": 130.0},
            unit="mg/dL",
            scope="global",
            user_id=None,
            reference_source="global",
        ))
        db_session.add(BiomarkerReading(
            entry_id="blood-feb",
            biomarker_id="ldl-zero",
            value=0.0,
            reference={"kind": "interval", "low": 0.0, "high": 130.0},
            status="normal",
        ))
        db_session.commit()

        import csv as csv_mod
        import io

        resp = await client.get("/api/export?format=csv")
        rows = list(csv_mod.reader(io.StringIO(resp.text.lstrip("\ufeff"))))
        header, data_rows = rows[0], rows[1:]
        row = next(r for r in data_rows if r[header.index("biomarker_id")] == "ldl-zero")
        assert row[header.index("value")] == "0.0"
        assert row[header.index("reference_low")] == "0.0"


class TestExportErrors:
    async def test_invalid_format_400_english(self, client):
        resp = await client.get("/api/export?format=xml")
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Invalid export format 'xml'. Supported: json, csv."

    async def test_invalid_format_400_localized_ru(self, db_session):
        async with _make_client(db_session, (None, TEST_ANON_ID, True)) as anon:
            resp = await anon.get(
                "/api/export?format=xml", headers={"Accept-Language": "ru"},
            )
        assert resp.status_code == 400
        assert resp.json()["detail"] == (
            "Недопустимый формат экспорта 'xml'. Поддерживается: json, csv."
        )

    @pytest.mark.parametrize("fmt", ["JSON", " CSV ", "Csv"])
    async def test_format_is_case_and_space_insensitive(self, client, fmt):
        resp = await client.get("/api/export", params={"format": fmt})
        assert resp.status_code == 200
