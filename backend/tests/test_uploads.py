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
        failed. The whole save must roll back together."""
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
                # Deliberately malformed visit_data JSON -> 400 further down.
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
