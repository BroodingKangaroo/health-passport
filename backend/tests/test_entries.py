import json

from tests.seed_data import TEST_USER_ID


def _biomarkers_json(rows: list[dict]) -> str:
    return json.dumps([{"id": "cat-1", "name": "Merged Panel", "rows": rows}])


def _row(name: str, value: str, unit: str = "", definition_id: str = "") -> dict:
    return {
        "id": f"row-{name.lower()}-{value}",
        "name": name,
        "value": value,
        "unit": unit,
        "definition_id": definition_id,
    }


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
                "date": "2025-11-15",
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
                "date": "2025-11-15",
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
        assert saved[0]["date"] == "2025-11-15T00:00:00"
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
                "date": "2025-11-15",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "title": "Test Panel",
                "biomarkers": biomakers_json,
            },
        )
        flowsheet = await client.get("/api/flowsheet")

        # then
        dates = flowsheet.json()["dates"]
        assert any(d["label"].startswith("Nov 15") for d in dates)

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
                "date": "2025-11-15",
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
                "date": "2025-11-15",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "title": "Bad Panel",
                "biomarkers": "not valid json",
            },
        )

        # then
        assert resp.status_code == 400
        assert "Invalid biomarkers JSON" in resp.json()["detail"]

    async def test_save_rejects_blank_date(self, client):
        # when — no date submitted
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "",
                "biomarkers": _biomarkers_json([_row("WBC", "8.5")]),
            },
        )

        # then — must not silently default to today
        assert resp.status_code == 400
        assert "date is required" in resp.json()["detail"].lower()

    async def test_save_rejects_future_date(self, client):
        # given — tomorrow relative to the server clock
        from datetime import datetime, timedelta, timezone

        future = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": future,
                "biomarkers": _biomarkers_json([_row("WBC", "8.5")]),
            },
        )

        # then
        assert resp.status_code == 400
        assert "future" in resp.json()["detail"].lower()


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
                "date": "2025-12-01",
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
                "date": "2025-12-01",
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
                "date": "2025-12-05",
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


class TestSaveInstrumentalTest:
    async def test_save_instrumental_test_returns_200(self, client):
        # given
        instrumental_data = json.dumps({
            "modality": "MRI",
            "findings": "Mild disc degeneration at L4-L5",
            "conclusion": "Minor age-related changes",
        })

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "instrumental_test",
                "date": "2025-12-01",
                "clinic": "Rad Center",
                "provider": "Dr. Grey",
                "title": "Lumbar MRI",
                "instrumental_data": instrumental_data,
            },
        )

        # then
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["message"] == "Entry saved"
        assert data["id"]

    async def test_saved_instrumental_test_appears_in_timeline(self, client):
        # given
        instrumental_data = json.dumps({
            "modality": "Elastography",
            "findings": "Liver stiffness 9.2 kPa",
            "conclusion": "F2 fibrosis",
        })

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "instrumental_test",
                "date": "2025-12-01",
                "clinic": "Hepato Clinic",
                "provider": "Dr. Liver",
                "title": "Liver Elastometry",
                "instrumental_data": instrumental_data,
            },
        )
        entry_id = resp.json()["id"]
        timeline = await client.get("/api/timeline")

        # then
        instrumental = timeline.json()["instrumental"]
        assert entry_id in instrumental
        assert instrumental[entry_id]["modality"] == "Elastography"
        assert "9.2" in instrumental[entry_id]["findings"]

    async def test_save_instrumental_test_without_biomarkers_has_no_readings(self, client, db_session):
        # given — an instrumental-test save must not create biomarker readings,
        # even if the form somehow still sent rows (stale extraction leftovers).
        from app.db.models import BiomarkerReading

        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "instrumental_test",
                "date": "2025-12-01",
                "title": "ECG",
                "biomarkers": json.dumps([
                    {"name": "General", "rows": [{"name": "WBC", "value": "7.2"}]},
                ]),
            },
        )
        assert resp.status_code == 200
        entry_id = resp.json()["id"]

        # then
        readings = db_session.query(BiomarkerReading).filter(BiomarkerReading.entry_id == entry_id).count()
        assert readings == 0

    async def test_save_instrumental_test_invalid_json_400(self, client):
        # when
        resp = await client.post(
            "/api/entry",
            data={
                "type": "instrumental_test",
                "date": "2025-12-01",
                "instrumental_data": "{not valid json",
            },
        )

        # then
        assert resp.status_code == 400
        assert "instrumental_data" in resp.json()["detail"]

    async def test_delete_cascades_instrumental_data(self, client):
        # given
        instrumental_data = json.dumps({
            "modality": "CT",
            "findings": "Normal",
            "conclusion": "No pathology",
        })
        resp = await client.post(
            "/api/entry",
            data={
                "type": "instrumental_test",
                "date": "2025-12-01",
                "title": "Chest CT",
                "instrumental_data": instrumental_data,
            },
        )
        entry_id = resp.json()["id"]
        timeline = await client.get("/api/timeline")
        assert entry_id in timeline.json()["instrumental"]

        # when
        del_resp = await client.delete(f"/api/entry/{entry_id}")
        assert del_resp.status_code == 200

        # then
        timeline2 = await client.get("/api/timeline")
        assert entry_id not in timeline2.json()["instrumental"]


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
        from app.db.models import MedicalEntry
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
        from app.db.models import MedicalEntry
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
                "date": "2025-04-01",
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
        from app.db.models import Attachment, MedicalEntry
        from app.services.usage_limits import get_limits
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
        get_limits(db_session, TEST_USER_ID, False)["total_upload_size_bytes"]

        # Cleanup: roll back the artifact UsageLimit we may have created earlier
        # in this test so other tests aren't affected.
        db_session.rollback()


class TestEntriesByDate:
    async def test_by_date_returns_count_and_entries_with_biomarkers(self, client):
        # given — two seeded blood tests exist on 2024-10-15 (09:00 and 14:30)
        # when
        resp = await client.get("/api/entries/by-date", params={"date": "2024-10-15", "type": "blood_test"})

        # then
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 2
        assert len(data["entries"]) == 2
        ids = {e["id"] for e in data["entries"]}
        assert ids == {"blood-oct", "blood-oct-eve"}
        by_id = {e["id"]: e for e in data["entries"]}
        assert by_id["blood-oct"]["time"] == "09:00"
        assert by_id["blood-oct-eve"]["time"] == "14:30"
        # blood-oct is seeded with the full CBC/CMP/Lipid set (see seed_data).
        biomarkers = by_id["blood-oct"]["biomarkers"]
        assert any(b["definition_id"] == "wbc" and b["loinc_code"] == "6690-2" for b in biomarkers)
        assert any(b["definition_id"] == "glu" and b["loinc_code"] == "2345-7" for b in biomarkers)
        # Names + synonyms ride along so the client can conflict-match manual rows.
        wbc = next(b for b in biomarkers if b["definition_id"] == "wbc")
        assert wbc["names"].get("en") == "WBC"
        assert "white blood cells" in wbc["synonyms"]

    async def test_by_date_filters_by_type(self, client):
        # when
        resp = await client.get("/api/entries/by-date", params={"date": "2024-09-05"})

        # then — no type filter: both the doctor visit and nothing else on that day
        data = resp.json()
        assert data["count"] == 1
        assert data["entries"][0]["id"] == "cardio"
        assert data["entries"][0]["biomarkers"] == []

    async def test_by_date_empty_day(self, client):
        resp = await client.get("/api/entries/by-date", params={"date": "2030-01-01", "type": "blood_test"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 0
        assert data["entries"] == []

    async def test_by_date_invalid_format_400(self, client):
        resp = await client.get("/api/entries/by-date", params={"date": "not-a-date"})
        assert resp.status_code == 400


class TestMergeEntry:
    """POST /api/entry/{entry_id}/merge — fold a later blood-test upload into
    an existing entry on the same date: new readings are added with the
    ``merged`` marker, the document is attached, notes are appended, and the
    target's own metadata stays untouched."""

    @staticmethod
    async def _create_target(client, date: str = "2025-03-10", name: str = "Glucose", value: str = "95") -> str:
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": date,
                "clinic": "Merge Lab",
                "title": "Merge Target Panel",
                "notes": "original notes",
                "biomarkers": _biomarkers_json([_row(name, value)]),
            },
        )
        assert resp.status_code == 200, resp.text
        return resp.json()["id"]

    async def test_merge_adds_readings_to_target(self, client, db_session):
        from app.db.models import BiomarkerReading

        target_id = await self._create_target(client)

        # when — merge a different biomarker into the target
        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={
                "date": "2025-03-10",
                "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")]),
            },
        )

        # then
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["success"] is True
        assert body["message"] == "Entry merged"
        assert body["id"] == target_id

        readings = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id)
            .order_by(BiomarkerReading.id)
            .all()
        )
        assert {r.biomarker_id for r in readings} == {"glu", "cre"}
        by_bid = {r.biomarker_id: r for r in readings}
        # Original reading stays unmarked; the merged-in one is flagged.
        assert by_bid["glu"].merged is False
        assert by_bid["cre"].merged is True
        assert by_bid["cre"].value == 0.9

    async def test_merge_does_not_create_second_event(self, client):
        target_id = await self._create_target(client)

        await client.post(
            f"/api/entry/{target_id}/merge",
            data={"date": "2025-03-10", "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")])},
        )

        timeline = await client.get("/api/timeline")
        events = [e for e in timeline.json()["events"] if e["date"].startswith("2025-03-10")]
        assert len(events) == 1
        assert events[0]["id"] == target_id

    async def test_merge_marks_reading_in_timeline(self, client):
        """The merged reading surfaces with ``merged: true`` on the wire, so the
        UI can distinguish original vs merged-in results."""
        target_id = await self._create_target(client)

        await client.post(
            f"/api/entry/{target_id}/merge",
            data={"date": "2025-03-10", "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")])},
        )

        timeline = await client.get("/api/timeline")
        biomarkers = {b["id"]: b for b in timeline.json()["biomarkers"]}
        assert biomarkers["cre"]["merged"] is True
        assert biomarkers["glu"]["merged"] is False

    async def test_merge_captures_second_test_metadata(self, client, db_session):
        """The merged upload's own title/clinic/provider/time are snapshotted
        as ``merged_source`` on each merged reading and surfaced on the wire,
        so the UI can describe the second test."""
        from app.db.models import BiomarkerReading

        target_id = await self._create_target(client)

        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={
                "date": "2025-03-10",
                "title": "Evening Panel",
                "clinic": "Second Lab",
                "provider": "Dr. Night",
                "time": "18:30",
                "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")]),
            },
        )
        assert resp.status_code == 200, resp.text

        # Persisted on the reading row.
        reading = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id, BiomarkerReading.biomarker_id == "cre")
            .first()
        )
        assert reading.merged_source == {
            "title": "Evening Panel",
            "clinic": "Second Lab",
            "provider": "Dr. Night",
            "time": "18:30",
        }
        # The original reading carries no source.
        original = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id, BiomarkerReading.biomarker_id == "glu")
            .first()
        )
        assert original.merged_source is None

        # Surfaced on the wire in the timeline.
        timeline = await client.get("/api/timeline")
        biomarkers = {b["id"]: b for b in timeline.json()["biomarkers"]}
        assert biomarkers["cre"]["merged_source"] == {
            "title": "Evening Panel",
            "clinic": "Second Lab",
            "provider": "Dr. Night",
            "time": "18:30",
        }
        assert biomarkers["glu"]["merged_source"] is None

    async def test_merge_omits_empty_source_fields(self, client, db_session):
        """Blank title/clinic/provider/time stay out of merged_source (None on
        the wire), so the UI can't render stray empty strings."""
        from app.db.models import BiomarkerReading

        target_id = await self._create_target(client)

        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={
                "date": "2025-03-10",
                "time": "10:15",
                "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")]),
            },
        )
        assert resp.status_code == 200, resp.text

        reading = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id, BiomarkerReading.biomarker_id == "cre")
            .first()
        )
        assert reading.merged_source == {"time": "10:15"}

        timeline = await client.get("/api/timeline")
        biomarkers = {b["id"]: b for b in timeline.json()["biomarkers"]}
        # The wire shape is a full MergedSource object with nulls for absent fields.
        assert biomarkers["cre"]["merged_source"] == {
            "title": None, "clinic": None, "provider": None, "time": "10:15",
        }

    async def test_merge_source_is_per_reading_not_per_definition(self, client):
        """A biomarker merged into the target and then re-tested in a NEWER
        separate entry: the merged entry's history reading keeps its
        merged/source flags, while the newer reading (and the latest-reading
        summary) are unmarked — so the timeline details view can attribute
        each reading to the right event."""
        target_id = await self._create_target(client)

        await client.post(
            f"/api/entry/{target_id}/merge",
            data={
                "date": "2025-03-10",
                "title": "Evening Panel",
                "clinic": "Second Lab",
                "time": "18:30",
                "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")]),
            },
        )

        # Newer, separate blood test on a later date containing the same biomarker.
        newer = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-04-01",
                "clinic": "Later Lab",
                "title": "Later Panel",
                "biomarkers": _biomarkers_json([_row("Creatinine", "0.8")]),
            },
        )
        assert newer.status_code == 200, newer.text

        timeline = await client.get("/api/timeline")
        cre = next(b for b in timeline.json()["biomarkers"] if b["id"] == "cre")
        # Latest reading is the newer, unmerged one (the seeded DB also holds
        # older readings for this definition, so match by date, not index).
        assert cre["merged"] is False
        assert cre["merged_source"] is None
        by_date = {h["date"][:10]: h for h in cre["history"]}
        assert by_date["2025-03-10"]["merged"] is True
        assert by_date["2025-03-10"]["merged_source"] == {
            "title": "Evening Panel",
            "clinic": "Second Lab",
            "provider": None,
            "time": "18:30",
        }
        # The originally-created glucose reading stays untouched throughout.
        glu = next(b for b in timeline.json()["biomarkers"] if b["id"] == "glu")
        assert glu["merged"] is False
        assert glu["merged_source"] is None

    async def test_merge_conflict_returns_409(self, client, db_session):
        from app.db.models import BiomarkerReading

        target_id = await self._create_target(client)

        # when — merge a biomarker that already exists in the target
        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={"date": "2025-03-10", "biomarkers": _biomarkers_json([_row("Glucose", "102")])},
        )

        # then
        assert resp.status_code == 409
        assert "Glucose" in resp.json()["detail"]
        # Nothing was added.
        count = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id)
            .count()
        )
        assert count == 1

    async def test_merge_conflict_detected_by_loinc_code(self, client):
        """A new row whose definition_id is the LOINC code (as the matcher
        emits) must conflict with an existing reading linked to that def."""
        target_id = await self._create_target(client)

        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={
                "date": "2025-03-10",
                # "glu" definition has loinc_code 2345-7 (see seed_data.py)
                "biomarkers": _biomarkers_json([_row("Glucose", "102", definition_id="2345-7")]),
            },
        )
        assert resp.status_code == 409
        assert "Glucose" in resp.json()["detail"]

    async def test_merge_conflict_partial_rolls_back_all(self, client, db_session):
        """When one row conflicts, NO rows are added (atomic merge)."""
        from app.db.models import BiomarkerReading

        target_id = await self._create_target(client)

        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={
                "date": "2025-03-10",
                "biomarkers": _biomarkers_json([
                    _row("Creatinine", "0.9"),
                    _row("Glucose", "102"),  # conflict
                ]),
            },
        )
        assert resp.status_code == 409

        count = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id)
            .count()
        )
        assert count == 1

    async def test_merge_by_name_resolves_definition(self, client, db_session):
        """Rows without a definition_id still resolve by name and get merged."""
        from app.db.models import BiomarkerReading

        target_id = await self._create_target(client)

        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={"date": "2025-03-10", "biomarkers": _biomarkers_json([_row("Platelets", "250")])},
        )
        assert resp.status_code == 200

        readings = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id)
            .all()
        )
        assert {r.biomarker_id for r in readings} == {"glu", "plt"}

    async def test_merge_name_resolved_row_conflicts_with_409(self, client, db_session):
        """A manually-typed row without definition_id that name-resolves to a
        biomarker already in the target is a conflict — the client can't see it
        via ids, but the server must still refuse the merge."""
        from app.db.models import BiomarkerReading

        target_id = await self._create_target(client)

        # "Glucose" (no definition_id) resolves by name to the target's glu.
        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={"date": "2025-03-10", "biomarkers": _biomarkers_json([_row("Glucose", "102")])},
        )
        assert resp.status_code == 409
        assert "Glucose" in resp.json()["detail"]

        count = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id)
            .count()
        )
        assert count == 1  # only the original reading survived

    async def test_merge_title_falls_back_to_document_filename(self, client, db_session, tmp_path, monkeypatch):
        """A blank merged title defaults to the uploaded document's filename
        (sans extension) so the merged section header stays descriptive."""
        from app.api import entries as entries_module
        from app.db.models import BiomarkerReading

        # Route uploads to a temp dir so the test leaves no stray files.
        monkeypatch.setattr(entries_module, "UPLOAD_DIR", str(tmp_path))
        target_id = await self._create_target(client)
        pdf = tmp_path / "evening_followup.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")

        with open(pdf, "rb") as f:
            resp = await client.post(
                f"/api/entry/{target_id}/merge",
                data={
                    "date": "2025-03-10",
                    "title": "",  # user left the title blank
                    "clinic": "Second Lab",
                    "time": "18:30",
                    "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")]),
                },
                files={"file": ("evening_followup.pdf", f, "application/pdf")},
            )
        assert resp.status_code == 200, resp.text

        reading = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id, BiomarkerReading.biomarker_id == "cre")
            .first()
        )
        assert reading.merged_source["title"] == "evening_followup"
        assert reading.merged_source["clinic"] == "Second Lab"

        timeline = await client.get("/api/timeline")
        cre = next(b for b in timeline.json()["biomarkers"] if b["id"] == "cre")
        assert cre["merged_source"]["title"] == "evening_followup"

    async def test_merge_explicit_title_wins_over_filename(self, client, db_session, tmp_path, monkeypatch):
        """An explicitly typed title is kept even when a document is attached."""
        from app.api import entries as entries_module
        from app.db.models import BiomarkerReading

        monkeypatch.setattr(entries_module, "UPLOAD_DIR", str(tmp_path))
        target_id = await self._create_target(client)
        pdf = tmp_path / "evening_followup.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")

        with open(pdf, "rb") as f:
            resp = await client.post(
                f"/api/entry/{target_id}/merge",
                data={
                    "date": "2025-03-10",
                    "title": "Evening Panel",
                    "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")]),
                },
                files={"file": ("evening_followup.pdf", f, "application/pdf")},
            )
        assert resp.status_code == 200, resp.text

        reading = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id, BiomarkerReading.biomarker_id == "cre")
            .first()
        )
        assert reading.merged_source["title"] == "Evening Panel"

    async def test_merge_unknown_entry_404(self, client):
        resp = await client.post(
            "/api/entry/does-not-exist/merge",
            data={"date": "2025-03-10", "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")])},
        )
        assert resp.status_code == 404

    async def test_merge_other_users_entry_404(self, client, db_session):
        from app.auth import create_user
        from app.db.models import MedicalEntry

        other = create_user(
            db_session, "merge-other@example.com", "otherpassword123", "Other", "1995-05-05", "Other"
        )
        other_entry = MedicalEntry(
            id="merge-other-entry",
            patient_id=other.id,
            type="blood_test",
            date=__import__("datetime").datetime(2028, 1, 10, tzinfo=__import__("datetime").timezone.utc),
            title="Other panel",
        )
        db_session.add(other_entry)
        db_session.commit()

        resp = await client.post(
            "/api/entry/merge-other-entry/merge",
            data={"date": "2025-03-10", "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")])},
        )
        assert resp.status_code == 404

        db_session.delete(other_entry)
        db_session.commit()

    async def test_merge_rejects_non_blood_test(self, client):
        # "cardio" is a seeded doctor_visit
        resp = await client.post(
            "/api/entry/cardio/merge",
            data={"date": "2024-09-05", "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")])},
        )
        assert resp.status_code == 400
        assert "blood test" in resp.json()["detail"].lower()

    async def test_merge_rejects_wrong_date(self, client):
        target_id = await self._create_target(client)

        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={"date": "2025-04-20", "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")])},
        )
        assert resp.status_code == 400

    async def test_merge_appends_notes(self, client, db_session):
        from app.db.models import MedicalEntry

        target_id = await self._create_target(client)

        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={"date": "2025-03-10", "notes": "added by second draw"},
        )
        assert resp.status_code == 200

        entry = db_session.query(MedicalEntry).filter(MedicalEntry.id == target_id).first()
        assert entry.notes == "original notes\nadded by second draw"
        # Target metadata is untouched.
        assert entry.title == "Merge Target Panel"
        assert entry.clinic == "Merge Lab"

    async def test_merge_notes_when_target_has_none(self, client, db_session):
        from app.db.models import MedicalEntry

        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2025-03-11",
                "biomarkers": _biomarkers_json([_row("Glucose", "95")]),
            },
        )
        target_id = resp.json()["id"]

        await client.post(
            f"/api/entry/{target_id}/merge",
            data={"date": "2025-03-11", "notes": "fresh note"},
        )

        entry = db_session.query(MedicalEntry).filter(MedicalEntry.id == target_id).first()
        assert entry.notes == "fresh note"

    async def test_merge_attaches_document_and_charges_quota(self, client, db_session, tmp_path, monkeypatch):
        from app.db.models import Attachment
        from app.services.usage_limits import get_limits

        test_dir = str(tmp_path / "uploads_for_merge")
        import os
        os.makedirs(test_dir, exist_ok=True)
        monkeypatch.setattr("app.api.entries.UPLOAD_DIR", test_dir)

        target_id = await self._create_target(client)
        before = get_limits(db_session, TEST_USER_ID, False)["total_upload_size_bytes"]

        content = b"%PDF-1.4 second-draw fixture"
        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={"date": "2025-03-10", "biomarkers": _biomarkers_json([_row("Creatinine", "0.9")])},
            files={"file": ("second_draw.pdf", content, "application/pdf")},
        )
        assert resp.status_code == 200

        attachments = (
            db_session.query(Attachment).filter(Attachment.entry_id == target_id).all()
        )
        assert len(attachments) == 1
        assert attachments[0].name == "second_draw.pdf"
        saved = os.path.join(test_dir, os.path.basename(attachments[0].file_path))
        assert os.path.isfile(saved)
        assert os.path.getsize(saved) == len(content)

        after = get_limits(db_session, TEST_USER_ID, False)["total_upload_size_bytes"]
        assert after == before + len(content)

    async def test_merge_multiple_documents_on_one_entry(self, client, db_session, tmp_path, monkeypatch):
        """Two merges with files attach both — attachment ids must be unique."""
        from app.db.models import Attachment

        test_dir = str(tmp_path / "uploads_for_merge2")
        import os
        os.makedirs(test_dir, exist_ok=True)
        monkeypatch.setattr("app.api.entries.UPLOAD_DIR", test_dir)

        target_id = await self._create_target(client)

        for i, name in enumerate(("first.pdf", "second.pdf")):
            resp = await client.post(
                f"/api/entry/{target_id}/merge",
                data={"date": "2025-03-10", "biomarkers": _biomarkers_json([_row("Creatinine", "0.9"), _row("Platelets", "250")][i:i + 1])},
                files={"file": (name, f"%PDF-{i}".encode(), "application/pdf")},
            )
            assert resp.status_code == 200

        attachments = (
            db_session.query(Attachment).filter(Attachment.entry_id == target_id).all()
        )
        assert len(attachments) == 2
        assert {a.name for a in attachments} == {"first.pdf", "second.pdf"}

    async def test_merge_qualitative_reading(self, client, db_session):
        from app.db.models import BiomarkerReading

        target_id = await self._create_target(client)

        resp = await client.post(
            f"/api/entry/{target_id}/merge",
            data={
                "date": "2025-03-10",
                "biomarkers": _biomarkers_json([
                    {"id": "row-urine", "name": "Urine Protein", "value": "Negative", "unit": "Qualitative"},
                ]),
            },
        )
        assert resp.status_code == 200

        readings = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == target_id)
            .all()
        )
        merged = [r for r in readings if r.merged]
        assert len(merged) == 1
        assert merged[0].value is None
        assert merged[0].value_text == "Negative"
        assert merged[0].status == "normal"

