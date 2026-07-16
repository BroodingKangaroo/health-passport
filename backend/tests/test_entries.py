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
