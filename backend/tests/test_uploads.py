import json
import os

import pytest


@pytest.fixture(autouse=True)
def _upload_dir(tmp_path, monkeypatch):
    """Redirect uploads to a temp directory that auto-cleans up."""
    test_dir = str(tmp_path / "uploads")
    os.makedirs(test_dir, exist_ok=True)
    monkeypatch.setattr("app.api.entries.UPLOAD_DIR", test_dir)
    yield


class TestFileUpload:
    async def _cleanup(self, url):
        """Remove the uploaded file if it exists."""
        from app.api.entries import UPLOAD_DIR
        p = os.path.join(UPLOAD_DIR, os.path.basename(url))
        if os.path.exists(p):
            os.remove(p)

    async def test_upload_disallowed_extension_rejected(self, client):
        """ISSUES.md #42: the client-supplied extension must not be kept
        verbatim — an .html/.svg upload served same-origin is a stored-XSS
        vector. Only the document/image allowlist is accepted."""
        from app.api.entries import UPLOAD_DIR

        before = set(os.listdir(UPLOAD_DIR))
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-12-15",
                "title": "XSS Attempt",
                "biomarkers": json.dumps([{"id": "cat-1", "name": "CBC", "rows": []}]),
            },
            files={"file": ("payload.html", b"<script>alert(1)</script>", "text/html")},
        )

        assert resp.status_code == 400
        assert "Unsupported file type '.html'" in resp.json()["detail"]
        # Nothing persisted: no file written, no entry/attachment row.
        assert set(os.listdir(UPLOAD_DIR)) == before

    async def test_upload_svg_extension_rejected(self, client):
        resp = await client.post(
            "/api/entry",
            data={
                "type": "doctor_visit",
                "date": "2025-12-16",
                "title": "SVG Attempt",
            },
            files={"file": ("vector.svg", b"<svg onload='alert(1)'/>", "image/svg+xml")},
        )
        assert resp.status_code == 400
        assert "Unsupported file type '.svg'" in resp.json()["detail"]

    async def test_upload_extension_case_insensitive(self, client):
        """The allowlist check is case-insensitive; the original extension is
        still kept in the saved name."""
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-12-17",
                "title": "Uppercase Ext",
                "biomarkers": json.dumps([{"id": "cat-1", "name": "CBC", "rows": []}]),
            },
            files={"file": ("report.PDF", b"%PDF-1.4 upper", "application/pdf")},
        )
        assert resp.status_code == 200
        entry_id = resp.json()["id"]
        timeline = await client.get("/api/timeline")
        entry = next(e for e in timeline.json()["events"] if e["id"] == entry_id)
        assert entry["attachments"][0]["url"].endswith(".PDF")
        await self._cleanup(entry["attachments"][0]["url"])

    async def test_upload_pdf_creates_file_on_disk(self, client):
        # given
        from app.api.entries import UPLOAD_DIR
        content = b"%PDF-1.4 fake pdf content for testing"
        biomakers_json = json.dumps([
            {"id": "cat-1", "name": "CBC", "rows": []},
        ])

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-12-15",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "title": "Upload Test",
                "biomarkers": biomakers_json,
            },
            files={"file": ("report.pdf", content, "application/pdf")},
        )

        # then
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True

        entry_id = data["id"]
        timeline = await client.get("/api/timeline")
        events = timeline.json()["events"]
        entry = next(e for e in events if e["id"] == entry_id)
        assert len(entry["attachments"]) == 1
        att = entry["attachments"][0]
        assert att["name"] == "report.pdf"
        assert att["url"] is not None
        assert att["url"].endswith(".pdf")
        assert att["url"].startswith("/static/uploads/")

        saved_path = os.path.join(UPLOAD_DIR, os.path.basename(att["url"]))
        assert os.path.exists(saved_path)
        with open(saved_path, "rb") as f:
            assert f.read() == content

    async def test_upload_with_invalid_visit_data_rolls_back_entry(self, client, db_session):
        """Regression: storage quota used to commit inside save_entry, leaving
        a committed-but-incomplete entry when a later step (invalid visit_data)
        failed. The whole save must roll back together. Since ISSUES.md #54
        the invalid payload is rejected BEFORE the upload is written, so no
        orphaned file can be left on disk either."""
        from app.db.models import MedicalEntry

        content = b"%PDF-1.4 fake pdf content"
        biomarkers_json = json.dumps([{"id": "cat-1", "name": "CBC", "rows": []}])

        before = db_session.query(MedicalEntry).count()

        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-12-15",
                "title": "Upload Test",
                "biomarkers": biomarkers_json,
                # Deliberately malformed visit_data JSON -> 400 (before write).
                "visit_data": "{not valid json",
            },
            files={"file": ("report.pdf", content, "application/pdf")},
        )

        assert resp.status_code == 400
        # The entry must never have been *committed*. In a real request the
        # request-scoped session closes and rolls back the pending flush; the
        # test shares that session, so roll it back to mimic connection close
        # and confirm nothing durable was written.
        db_session.rollback()
        assert db_session.query(MedicalEntry).count() == before
        # ISSUES.md #54: nothing may be orphaned on disk.
        from app.api.entries import UPLOAD_DIR
        assert os.listdir(UPLOAD_DIR) == []

    async def test_upload_with_invalid_instrumental_data_leaves_no_file(
        self, client
    ):
        """ISSUES.md #54: malformed instrumental_data is rejected before the
        upload is written to disk."""
        from app.api.entries import UPLOAD_DIR

        before = set(os.listdir(UPLOAD_DIR))
        resp = await client.post(
            "/api/entry",
            data={
                "type": "instrumental_test",
                "date": "2025-12-15",
                "title": "Upload Test",
                # Deliberately malformed instrumental_data JSON -> 400.
                "instrumental_data": "{not valid json",
            },
            files={"file": ("report.pdf", b"%PDF-1.4 fake", "application/pdf")},
        )
        assert resp.status_code == 400
        assert set(os.listdir(UPLOAD_DIR)) == before

    async def test_late_failure_unlinks_saved_file(
        self, client, db_session, monkeypatch
    ):
        """ISSUES.md #54 safety net: when something raises AFTER the file was
        written, the file must be unlinked instead of orphaned with no DB
        row (upload_cleanup only runs on delete)."""
        import app.api.entries as entries_mod
        from app.api.entries import UPLOAD_DIR

        def boom(*args, **kwargs):
            raise RuntimeError("late failure")

        monkeypatch.setattr(entries_mod, "_build_visit_data_model", boom)
        with pytest.raises(RuntimeError, match="late failure"):
            await client.post(
                "/api/entry",
                data={
                    "type": "doctor_visit",
                    "date": "2025-12-15",
                    "title": "Upload Test",
                    # Valid JSON — parsing passes, the forced builder failure
                    # happens after _save_attachment wrote the file.
                    "visit_data": json.dumps({"diagnosis": {"original": "x"}}),
                },
                files={"file": ("report.pdf", b"%PDF-1.4 fake", "application/pdf")},
            )
        assert os.listdir(UPLOAD_DIR) == []
        db_session.rollback()

    async def test_uploaded_file_url_in_timeline_response(self, client):
        # given
        content = b"dummy pdf bytes"
        biomakers_json = json.dumps([
            {"id": "cat-1", "name": "CBC", "rows": [
                {"id": "wbc", "name": "WBC", "value": "6.5", "unit": "K/µL", "range": "4.0-11.0"},
            ]},
        ])

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-12-20",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "biomarkers": biomakers_json,
            },
            files={"file": ("lab.pdf", content, "application/pdf")},
        )
        entry_id = resp.json()["id"]
        timeline = await client.get("/api/timeline")

        # then
        events = timeline.json()["events"]
        entry = next(e for e in events if e["id"] == entry_id)
        assert len(entry["attachments"]) == 1
        assert entry["attachments"][0]["url"].startswith("/static/uploads/")

    async def test_uploaded_file_url_in_visit_detail(self, client):
        # given
        content = b"visit notes pdf"
        visit_data = json.dumps({
            "diagnosis": {"original": "Test Diagnosis", "translated_en": "Test Diagnosis"},
            "chief_complaint": {"original": "Cough", "translated_en": "Cough"},
            "objective_findings": {"original": "Clear lungs", "translated_en": "Clear lungs"},
            "prescriptions": [],
            "recommendations": [],
        })

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "doctor_visit",
                "date": "2025-12-25",
                "clinic": "Test Clinic",
                "provider": "Dr. Test",
                "title": "Test Visit",
                "visit_data": visit_data,
            },
            files={"file": ("visit.pdf", content, "application/pdf")},
        )
        entry_id = resp.json()["id"]
        visit_resp = await client.get(f"/api/visit-data/{entry_id}")

        # then
        assert visit_resp.status_code == 200
        vd = visit_resp.json()
        assert len(vd["attachments"]) == 1
        assert vd["attachments"][0]["url"].startswith("/static/uploads/")

    async def test_upload_png_preserves_extension(self, client):
        # given
        content = b"fake png bytes"
        biomakers_json = json.dumps([
            {"id": "cat-1", "name": "CBC", "rows": []},
        ])

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-12-30",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "biomarkers": biomakers_json,
            },
            files={"file": ("scan.png", content, "image/png")},
        )
        entry_id = resp.json()["id"]
        timeline = await client.get("/api/timeline")
        events = timeline.json()["events"]
        entry = next(e for e in events if e["id"] == entry_id)

        # then
        att = entry["attachments"][0]
        assert att["url"].endswith(".png")

    async def test_upload_without_file_no_attachment(self, client):
        # given
        biomakers_json = json.dumps([
            {"id": "cat-1", "name": "CBC", "rows": [
                {"id": "wbc", "name": "WBC", "value": "7.0", "unit": "K/µL", "range": "4.0-11.0"},
            ]},
        ])

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-01-05",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "biomarkers": biomakers_json,
            },
        )
        entry_id = resp.json()["id"]
        timeline = await client.get("/api/timeline")
        events = timeline.json()["events"]
        entry = next(e for e in events if e["id"] == entry_id)

        # then
        assert len(entry.get("attachments", [])) == 0

    async def test_multiple_uploads_unique_filenames(self, client):
        # given
        biomakers_json = json.dumps([
            {"id": "cat-1", "name": "CBC", "rows": []},
        ])

        # when
        resp1 = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-02-01",
                "clinic": "Lab A",
                "provider": "Dr. A",
                "biomarkers": biomakers_json,
            },
            files={"file": ("a.pdf", b"content a", "application/pdf")},
        )
        resp2 = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-02-02",
                "clinic": "Lab B",
                "provider": "Dr. B",
                "biomarkers": biomakers_json,
            },
            files={"file": ("b.pdf", b"content b", "application/pdf")},
        )

        # then
        id1 = resp1.json()["id"]
        id2 = resp2.json()["id"]
        timeline = await client.get("/api/timeline")
        events = timeline.json()["events"]
        e1 = next(e for e in events if e["id"] == id1)
        e2 = next(e for e in events if e["id"] == id2)
        url1 = e1["attachments"][0]["url"]
        url2 = e2["attachments"][0]["url"]
        assert url1 != url2


class TestServeUploadHeaders:
    """ISSUES.md #42: served uploads must never render inline on the API
    origin. Exercises the real route on app.main (the `client` fixture builds
    its own app without the /static/uploads route)."""

    async def test_served_upload_gets_nosniff_and_attachment(self, db_session, tmp_path, monkeypatch):
        from datetime import datetime, timezone

        from fastapi import Request, Response
        from httpx import ASGITransport, AsyncClient

        from app.api.auth import get_current_user_or_anon
        from app.db.models import Attachment, MedicalEntry, Patient
        from app.db.session import get_db
        from app.main import app as main_app
        from tests.seed_data import TEST_USER_EMAIL, TEST_USER_ID

        monkeypatch.chdir(tmp_path)
        uploads = tmp_path / "static" / "uploads"
        uploads.mkdir(parents=True)
        (uploads / "att.pdf").write_bytes(b"%PDF-1.4 served upload")

        user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
        if not user:
            from app.auth import create_user
            user = create_user(db_session, TEST_USER_EMAIL, "testpassword123", "Test User", "1990-01-01", "Other")
            db_session.commit()

        db_session.add(MedicalEntry(
            id="serve-entry",
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=datetime(2025, 6, 1, tzinfo=timezone.utc),
            title="Serve Test",
        ))
        db_session.add(Attachment(
            id="att-serve",
            entry_id="serve-entry",
            name="Отчёт анализ.pdf",
            type="Uploaded Document",
            size="1 KB",
            file_path="/static/uploads/att.pdf",
        ))
        db_session.commit()

        async def override_get_db():
            yield db_session

        async def override_principal(request: Request, response: Response):
            return (user, TEST_USER_ID, False)

        main_app.dependency_overrides[get_db] = override_get_db
        main_app.dependency_overrides[get_current_user_or_anon] = override_principal
        try:
            transport = ASGITransport(app=main_app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.get("/static/uploads/att.pdf")
        finally:
            main_app.dependency_overrides.clear()

        assert resp.status_code == 200
        assert resp.headers["x-content-type-options"] == "nosniff"
        cd = resp.headers["content-disposition"]
        assert cd.startswith("attachment;")
        # ASCII fallback is sanitized; the RFC 5987 form keeps the Cyrillic name.
        assert 'filename="' in cd
        assert "filename*=UTF-8''" in cd
        assert "%D0%9E%D1%82%D1%87%D1%91%D1%82" in cd

    async def test_served_upload_missing_file_404(self, db_session, tmp_path, monkeypatch):
        from fastapi import Request, Response
        from httpx import ASGITransport, AsyncClient

        from app.api.auth import get_current_user_or_anon
        from app.db.session import get_db
        from app.main import app as main_app

        monkeypatch.chdir(tmp_path)
        (tmp_path / "static" / "uploads").mkdir(parents=True)

        async def override_get_db():
            yield db_session

        async def override_principal(request: Request, response: Response):
            return (None, "anon-x", True)

        main_app.dependency_overrides[get_db] = override_get_db
        main_app.dependency_overrides[get_current_user_or_anon] = override_principal
        try:
            transport = ASGITransport(app=main_app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.get("/static/uploads/nope.pdf")
        finally:
            main_app.dependency_overrides.clear()

        assert resp.status_code == 404
