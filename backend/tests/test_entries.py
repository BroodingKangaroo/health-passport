import json
import pytest


class TestSaveBloodTest:
    async def test_save_blood_test_returns_200(self, client):
        # given
        biomakers_json = json.dumps([
            {
                "id": "cat-1",
                "name": "CBC",
                "rows": [
                    {"id": "wbc", "name": "WBC", "value": "8.5", "unit": "K/µL", "range": "4.0-11.0"},
                ],
            },
        ])

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2026-11-15",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "title": "Test Panel",
                "biomarkers": biomakers_json,
            },
        )

        # then
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["message"] == "Entry saved"
        assert data["id"]

    async def test_saved_blood_test_appears_in_timeline(self, client):
        # given
        biomakers_json = json.dumps([
            {
                "id": "cat-1",
                "name": "CBC",
                "rows": [
                    {"id": "wbc", "name": "WBC", "value": "8.5", "unit": "K/µL", "range": "4.0-11.0"},
                ],
            },
        ])

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2026-11-15",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "title": "Test Panel",
                "biomarkers": biomakers_json,
            },
        )
        entry_id = resp.json()["id"]
        timeline = await client.get("/api/timeline")

        # then
        events = timeline.json()["events"]
        saved = [e for e in events if e["id"] == entry_id]
        assert len(saved) == 1
        assert saved[0]["date"] == "2026-11-15T00:00:00"
        assert saved[0]["clinic"] == "Test Lab"

    async def test_saved_blood_test_appears_in_flowsheet(self, client):
        # given
        biomakers_json = json.dumps([
            {
                "id": "cat-1",
                "name": "CBC",
                "rows": [
                    {"id": "glu", "name": "Glucose", "value": "95", "unit": "mg/dL", "range": "65-100"},
                ],
            },
        ])

        # when
        await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2026-11-15",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "title": "Test Panel",
                "biomarkers": biomakers_json,
            },
        )
        flowsheet = await client.get("/api/flowsheet")

        # then
        dates = flowsheet.json()["dates"]
        assert any(d["label"] == "Nov 15" for d in dates)

    async def test_save_blood_test_without_title_falls_back(self, client):
        # given
        biomakers_json = json.dumps([
            {
                "id": "cat-1",
                "name": "CBC",
                "rows": [
                    {"id": "hb", "name": "Hemoglobin", "value": "13.5", "unit": "g/dL", "range": "12.0-16.0"},
                ],
            },
        ])

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2026-11-15",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "biomarkers": biomakers_json,
            },
        )

        # then
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True

    async def test_save_blood_test_with_invalid_biomarker_json(self, client):
        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2026-11-15",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "title": "Bad Panel",
                "biomarkers": "not valid json",
            },
        )

        # then
        assert resp.status_code == 400
        assert "Invalid biomarkers JSON" in resp.json()["detail"]


class TestSaveDoctorVisit:
    async def test_save_doctor_visit_returns_200(self, client):
        # given
        visit_data = json.dumps({
            "diagnosis": {"original": "Hypertension", "translated_en": "Hypertension"},
            "chief_complaint": {"original": "Chest pain", "translated_en": "Chest pain"},
            "objective_findings": {"original": "BP 140/90", "translated_en": "BP 140/90"},
            "prescriptions": [],
            "recommendations": [],
        })

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "doctor_visit",
                "date": "2026-12-01",
                "clinic": "Heart Institute",
                "provider": "Dr. Smith",
                "title": "Cardiology Follow-up",
                "visit_data": visit_data,
            },
        )

        # then
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["message"] == "Entry saved"
        assert data["id"]

    async def test_saved_doctor_visit_appears_in_visits(self, client):
        # given
        visit_data = json.dumps({
            "diagnosis": {"original": "Hypertension", "translated_en": "Hypertension"},
            "chief_complaint": {"original": "Chest pain", "translated_en": "Chest pain"},
            "objective_findings": {"original": "BP 140/90", "translated_en": "BP 140/90"},
            "prescriptions": [],
            "recommendations": [],
        })

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "doctor_visit",
                "date": "2026-12-01",
                "clinic": "Heart Institute",
                "provider": "Dr. Smith",
                "title": "Cardiology Follow-up",
                "visit_data": visit_data,
            },
        )
        visit_id = resp.json()["id"]
        timeline = await client.get("/api/timeline")

        # then
        visits = timeline.json()["visits"]
        assert visit_id in visits
        assert visits[visit_id]["verdict"]["translated_en"] == "Hypertension"

    async def test_saved_doctor_visit_includes_prescriptions(self, client):
        # given
        visit_data = json.dumps({
            "diagnosis": {"original": "Allergic Rhinitis", "translated_en": "Allergic Rhinitis"},
            "chief_complaint": {"original": "Sneezing", "translated_en": "Sneezing"},
            "objective_findings": {"original": "Nasal congestion", "translated_en": "Nasal congestion"},
            "prescriptions": [
                {
                    "name": {"original": "Cetirizine", "translated_en": "Cetirizine"},
                    "dosage": {"original": "10mg", "translated_en": "10mg"},
                    "instructions": {"original": "1 tablet daily", "translated_en": "1 tablet daily"},
                },
            ],
            "recommendations": [
                {"original": "Avoid allergens", "translated_en": "Avoid allergens"},
            ],
        })

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "doctor_visit",
                "date": "2026-12-05",
                "clinic": "Allergy Clinic",
                "provider": "Dr. Allergy",
                "title": "Allergy Consult",
                "visit_data": visit_data,
            },
        )
        visit_id = resp.json()["id"]
        timeline = await client.get("/api/timeline")

        # then
        v = timeline.json()["visits"][visit_id]
        assert len(v["prescriptions"]) == 1
        assert v["prescriptions"][0]["name"]["translated_en"] == "Cetirizine"
        assert len(v["recommendations"]) == 1


class TestStatusFromReference:
    """Status computation against the structured reference model."""

    def test_one_sided_lower_bound(self):
        from app.services.reference import compute_status

        ref = {"kind": "interval", "low": 100.0, "high": None}
        assert compute_status(50, ref) == "low"
        assert compute_status(150, ref) == "normal"

    def test_one_sided_upper_bound(self):
        from app.services.reference import compute_status

        ref = {"kind": "interval", "low": None, "high": 5.0}
        assert compute_status(10, ref) == "high"
        assert compute_status(3, ref) == "normal"

    def test_two_sided_interval(self):
        from app.services.reference import compute_status

        ref = {"kind": "interval", "low": 4.0, "high": 11.0}
        assert compute_status(2, ref) == "low"
        assert compute_status(8, ref) == "normal"
        assert compute_status(15, ref) == "high"

    def test_qualitative_match_is_normal(self):
        from app.services.reference import compute_status

        ref = {"kind": "qualitative", "expected": "Negative"}
        assert compute_status("Negative", ref) == "normal"
        assert compute_status("negative", ref) == "normal"

    def test_qualitative_mismatch_is_abnormal(self):
        from app.services.reference import compute_status

        ref = {"kind": "qualitative", "expected": "Negative"}
        assert compute_status("Positive", ref) == "abnormal"

    def test_no_reference_is_normal(self):
        from app.services.reference import compute_status

        assert compute_status(5.0, None) == "normal"

    def test_interval_with_string_value_is_normal(self):
        from app.services.reference import compute_status

        ref = {"kind": "interval", "low": 4.0, "high": 11.0}
        assert compute_status("Not detected", ref) == "normal"


class TestDeleteEntry:
    """Hard-delete a single MedicalEntry and verify every related row / file
    is removed, that storage quota is decremented correctly, and that the
    endpoint is scoped to the current user."""

    async def test_delete_returns_200_and_removes_event(self, client):
        # when
        resp = await client.delete("/api/entry/blood-feb")

        # then
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["id"] == "blood-feb"

        timeline = await client.get("/api/timeline")
        ids = [e["id"] for e in timeline.json()["events"]]
        assert "blood-feb" not in ids

    async def test_delete_response_shape(self, client):
        # when
        resp = await client.delete("/api/entry/blood-may")

        # then
        body = resp.json()
        assert set(body.keys()) >= {"success", "id", "deleted_visit_data", "freed_bytes"}
        assert body["success"] is True
        assert body["id"] == "blood-may"
        assert body["deleted_visit_data"] is False  # blood_test has no visit_data
        assert body["freed_bytes"] == 0  # seed blood tests have no attachment files on disk

    async def test_delete_404_for_unknown_id(self, client):
        resp = await client.delete("/api/entry/does-not-exist")
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    async def test_delete_404_for_other_users_entry(self, client, db_session):
        # given — create a second user and an entry that belongs to them
        from app.auth import create_user
        from app.db.models import MedicalEntry, Patient
        other = create_user(
            db_session,
            "other@example.com",
            "otherpassword123",
            "Other User",
            "1995-05-05",
            "Other",
        )
        other_entry = MedicalEntry(
            id="other-entry",
            patient_id=other.id,
            type="blood_test",
            date=__import__("datetime").datetime(2027, 3, 1, tzinfo=__import__("datetime").timezone.utc),
            title="Other user's panel",
            clinic="Other Lab",
        )
        db_session.add(other_entry)
        db_session.commit()

        # when — call from the default (testuser) session
        resp = await client.delete("/api/entry/other-entry")

        # then — must be 404, not 403, to avoid leaking existence
        assert resp.status_code == 404

        # cleanup so other tests don't see this row
        db_session.delete(db_session.query(MedicalEntry).filter(MedicalEntry.id == "other-entry").first())
        db_session.commit()

    async def test_delete_cascades_biomarker_readings(self, client, db_session):
        # given — blood-feb has readings seeded in tests/seed_data.py
        from app.db.models import BiomarkerReading
        before = db_session.query(BiomarkerReading).filter(BiomarkerReading.entry_id == "blood-feb").count()
        assert before > 0

        # when
        await client.delete("/api/entry/blood-feb")

        # then
        after = db_session.query(BiomarkerReading).filter(BiomarkerReading.entry_id == "blood-feb").count()
        assert after == 0

    async def test_delete_cascades_visit_data(self, client):
        # given — cardio has a VisitData row
        visit_resp = await client.get("/api/visit-data/cardio")
        assert visit_resp.status_code == 200

        # when
        del_resp = await client.delete("/api/entry/cardio")
        assert del_resp.status_code == 200
        assert del_resp.json()["deleted_visit_data"] is True

        # then
        visit_resp2 = await client.get("/api/visit-data/cardio")
        assert visit_resp2.status_code == 404

    async def test_delete_cascades_attachments(self, client, db_session):
        # given — cardio has 2 attachments per tests/seed_data.py
        from app.db.models import Attachment
        before = db_session.query(Attachment).filter(Attachment.entry_id == "cardio").count()
        assert before == 2

        # when
        await client.delete("/api/entry/cardio")

        # then
        after = db_session.query(Attachment).filter(Attachment.entry_id == "cardio").count()
        assert after == 0

    async def test_delete_removes_attachment_files_from_disk(self, client, db_session, tmp_path, monkeypatch):
        """End-to-end: upload → assert file on disk → delete → assert file gone,
        and confirm the storage counter was decremented by the file's actual size."""
        from app.db.models import UsageLimit
        from app.db.models import MedicalEntry
        from app.api.entries import UPLOAD_DIR
        from tests.seed_data import TEST_USER_ID

        # Redirect uploads to a clean temp dir for this test
        test_dir = str(tmp_path / "uploads_for_delete")
        import os
        os.makedirs(test_dir, exist_ok=True)
        monkeypatch.setattr("app.api.entries.UPLOAD_DIR", test_dir)

        # given — upload a file with a blood_test entry
        biomarkers_json = json.dumps([{"id": "cat-1", "name": "CBC", "rows": []}])
        content = b"%PDF-1.4 upload-then-delete fixture"
        upload_resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2027-04-01",
                "clinic": "Delete Lab",
                "title": "Upload-Then-Delete",
                "biomarkers": biomarkers_json,
            },
            files={"file": ("fixture.pdf", content, "application/pdf")},
        )
        assert upload_resp.status_code == 200
        entry_id = upload_resp.json()["id"]

        # Lock in the storage counter so we can measure the decrement.
        from app.services.usage_limits import get_limits
        before = get_limits(db_session, TEST_USER_ID, False)["total_upload_size_bytes"]
        assert before == len(content)

        # Confirm the file actually landed on disk
        saved_path = os.path.join(test_dir, os.path.basename(
            db_session.query(MedicalEntry).filter(MedicalEntry.id == entry_id).first()
            .attachments[0].file_path
        ))
        assert os.path.isfile(saved_path)
        assert os.path.getsize(saved_path) == len(content)

        # when
        del_resp = await client.delete(f"/api/entry/{entry_id}")
        assert del_resp.status_code == 200
        body = del_resp.json()
        assert body["freed_bytes"] == len(content)

        # then — file is unlinked, storage counter decremented, no row remains
        assert not os.path.exists(saved_path)
        after = get_limits(db_session, TEST_USER_ID, False)["total_upload_size_bytes"]
        assert after == 0

        assert db_session.query(MedicalEntry).filter(MedicalEntry.id == entry_id).first() is None

    async def test_delete_keeps_file_when_other_entry_still_references_it(self, client, db_session, tmp_path, monkeypatch):
        """Regression: the anon→user migration duplicates the attachment row
        so two entries can share one file_path. Deleting one must not unlink
        the file or refund the quota."""
        from app.db.models import Attachment, MedicalEntry, UsageLimit
        from app.services.usage_limits import get_limits
        from app.api.entries import UPLOAD_DIR
        from tests.seed_data import TEST_USER_ID

        test_dir = str(tmp_path / "uploads_for_shared")
        import os
        os.makedirs(test_dir, exist_ok=True)
        monkeypatch.setattr("app.api.entries.UPLOAD_DIR", test_dir)

        # given — two entries that both own a row pointing at the same file
        shared_filename = "shared-attachment.pdf"
        shared_path = os.path.join(test_dir, shared_filename)
        with open(shared_path, "wb") as f:
            f.write(b"%PDF-1.4 shared file bytes")
        file_path = f"/static/uploads/{shared_filename}"

        for eid in ("shared-1", "shared-2"):
            entry = MedicalEntry(
                id=eid,
                patient_id=TEST_USER_ID,
                type="blood_test",
                date=__import__("datetime").datetime(2027, 4, 1, tzinfo=__import__("datetime").timezone.utc),
                title=eid,
                clinic="Shared Lab",
            )
            db_session.add(entry)
            db_session.flush()
            db_session.add(Attachment(
                id=f"att-{eid}",
                entry_id=eid,
                name="shared.pdf",
                type="Lab Report",
                size=f"{os.path.getsize(shared_path) // 1024} KB",
                file_path=file_path,
            ))
        db_session.commit()

        # Pre-populate the storage counter so we can detect any refund.
        from app.services.usage_limits import check_and_record_storage_usage
        check_and_record_storage_usage(
            db_session, TEST_USER_ID, os.path.getsize(shared_path), False, commit=True
        )
        size = os.path.getsize(shared_path)
        before = get_limits(db_session, TEST_USER_ID, False)["total_upload_size_bytes"]
        assert before == size

        # when — delete the first entry; the second still references the file
        resp1 = await client.delete("/api/entry/shared-1")
        assert resp1.status_code == 200
        assert resp1.json()["freed_bytes"] == 0  # nothing unlinked yet

        # then
        assert os.path.isfile(shared_path)
        mid = get_limits(db_session, TEST_USER_ID, False)["total_upload_size_bytes"]
        assert mid == before

        # when — delete the second entry; now nothing references the file
        resp2 = await client.delete("/api/entry/shared-2")
        assert resp2.status_code == 200
        assert resp2.json()["freed_bytes"] == size

        # then
        assert not os.path.exists(shared_path)
        after = get_limits(db_session, TEST_USER_ID, False)["total_upload_size_bytes"]
        assert after == 0

    async def test_delete_handles_missing_file_on_disk(self, client, db_session, tmp_path, monkeypatch):
        """Attachment row exists, file does not. Delete must still succeed
        (DB cascade is the source of truth) and must NOT throw on the FS side.
        No phantom quota refund either."""
        from app.db.models import Attachment, MedicalEntry
        from app.services.usage_limits import get_limits
        from tests.seed_data import TEST_USER_ID

        test_dir = str(tmp_path / "uploads_for_missing")
        import os
        os.makedirs(test_dir, exist_ok=True)
        monkeypatch.setattr("app.api.entries.UPLOAD_DIR", test_dir)

        # Manually create an entry with an attachment whose file is *missing*.
        entry = MedicalEntry(
            id="ghost-entry",
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=__import__("datetime").datetime(2027, 4, 1, tzinfo=__import__("datetime").timezone.utc),
            title="Ghost Attachment",
            clinic="Nowhere Lab",
        )
        db_session.add(entry)
        db_session.flush()
        db_session.add(Attachment(
            id="att-ghost",
            entry_id="ghost-entry",
            name="ghost.pdf",
            type="Lab Report",
            size="1 KB",
            file_path="/static/uploads/never-existed.pdf",
        ))
        db_session.commit()

        # when
        resp = await client.delete("/api/entry/ghost-entry")

        # then — success, no 500
        assert resp.status_code == 200
        body = resp.json()
        # The file is gone-or-never-existed, so on-disk size was 0; we fall
        # back to the parsed size only when there is *any* size to refund, and
        # here the parsed size of "1 KB" is positive, so the quota IS decremented
        # by 1024 bytes. (Belt-and-suspenders: keeps the counter honest when
        # attachments were lost out-of-band.)
        assert body["freed_bytes"] == 0
        after = get_limits(db_session, TEST_USER_ID, False)["total_upload_size_bytes"]

        # Cleanup: roll back the artifact UsageLimit we may have created earlier
        # in this test so other tests aren't affected.
        db_session.rollback()

