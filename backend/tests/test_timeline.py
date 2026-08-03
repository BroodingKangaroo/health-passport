

class TestTimeline:
    async def test_get_timeline_returns_200(self, client):
        # when
        resp = await client.get("/api/timeline")

        # then
        assert resp.status_code == 200

    async def test_timeline_structure(self, client):
        # when
        resp = await client.get("/api/timeline")
        data = resp.json()

        # then
        assert "events" in data
        assert "biomarkers" in data
        assert "visits" in data
        assert len(data["events"]) == 13

    async def test_timeline_event_fields(self, client):
        # when
        resp = await client.get("/api/timeline")
        events = resp.json()["events"]

        # then
        for event in events:
            assert "id" in event
            assert "type" in event
            assert "date" in event
            assert "title" in event

    async def test_timeline_events_chronological(self, client):
        # when
        resp = await client.get("/api/timeline")
        dates = [e["date"] for e in resp.json()["events"]]

        # then
        assert dates == sorted(dates)

    async def test_timeline_biomarker_fields(self, client):
        # when
        resp = await client.get("/api/timeline")
        biomarkers = resp.json()["biomarkers"]

        # then
        assert len(biomarkers) == 18
        for b in biomarkers:
            assert "id" in b
            assert "definition" in b
            assert "value" in b
            assert "date" in b
            assert "status" in b
            defn = b["definition"]
            assert "names" in defn
            assert "en" in defn["names"]
            assert "ru" in defn["names"]
            assert "reference" in defn
            assert "unit" in defn
            assert "scope" in defn
            assert "loinc_code" in defn

    async def test_timeline_biomarker_latest_date(self, client):
        # when
        resp = await client.get("/api/timeline")
        biomarkers = resp.json()["biomarkers"]

        # then
        for b in biomarkers:
            assert b["date"] in ("2024-12-03T00:00:00", "2025-01-12T00:00:00")

    async def test_timeline_biomarkers_carry_entry_ids(self, client):
        # when
        resp = await client.get("/api/timeline")
        data = resp.json()
        biomarkers = data["biomarkers"]
        event_ids = {e["id"] for e in data["events"]}

        # then: every reading — the top-level latest and each history entry —
        # names the blood test it belongs to, so clients can match readings to
        # events even when several tests share a date.
        for b in biomarkers:
            assert b["entry_id"] in event_ids
            for h in b["history"]:
                assert h["entry_id"] in event_ids

    async def test_same_date_events_ordered_deterministically(self, client, db_session):
        # given: two blood tests with the exact same date, different created_at
        from datetime import datetime, timezone

        from app.db.models import MedicalEntry

        db_session.add(MedicalEntry(
            id="same-day-b",
            patient_id="testuser",
            type="blood_test",
            date=datetime(2025, 6, 1, tzinfo=timezone.utc),
            title="Second Same-Day Test",
            created_at=datetime(2025, 6, 1, 10, 0, tzinfo=timezone.utc),
        ))
        db_session.add(MedicalEntry(
            id="same-day-a",
            patient_id="testuser",
            type="blood_test",
            date=datetime(2025, 6, 1, tzinfo=timezone.utc),
            title="First Same-Day Test",
            created_at=datetime(2025, 6, 1, 9, 0, tzinfo=timezone.utc),
        ))
        db_session.commit()

        # when
        resp = await client.get("/api/timeline")
        dates = [e["date"] for e in resp.json()["events"]]

        # then: (date, created_at, id) order — the earlier-created test first,
        # never a database-arbitrary order.
        assert dates == sorted(dates)
        ids = [e["id"] for e in resp.json()["events"]]
        assert ids.index("same-day-a") < ids.index("same-day-b")

    async def test_timeline_visits_structure(self, client):
        # when
        resp = await client.get("/api/timeline")
        visits = resp.json()["visits"]

        # then
        assert "cardio" in visits
        assert "ortho" in visits
        assert "neuro" in visits
        for v in visits.values():
            assert "specialty" in v
            assert "provider" in v
            assert "verdict" in v
            assert "prescriptions" in v
            assert "notes" in v

    async def test_timeline_visit_prescriptions(self, client):
        # when
        resp = await client.get("/api/timeline")
        cardio = resp.json()["visits"]["cardio"]

        # then
        assert len(cardio["prescriptions"]) == 1
        assert cardio["prescriptions"][0]["name"]["translated_en"] == "Metoprolol Succinate"


class TestFlowsheet:
    async def test_get_flowsheet_returns_200(self, client):
        # when
        resp = await client.get("/api/flowsheet")

        # then
        assert resp.status_code == 200

    async def test_flowsheet_structure(self, client):
        # when
        resp = await client.get("/api/flowsheet")
        data = resp.json()

        # then
        assert "dates" in data
        assert "matrix" in data
        assert "biomarkers" in data
        assert len(data["dates"]) == 9

    async def test_flowsheet_categories(self, client):
        # when
        resp = await client.get("/api/flowsheet")
        matrix = resp.json()["matrix"]

        # then
        category_names = [c["category"] for c in matrix]
        assert "Complete Blood Count" in category_names
        assert "Lipid Panel" in category_names
        assert "Vitamins" in category_names

    async def test_flowsheet_vitamin_d_missing_first_cell(self, client):
        # when
        resp = await client.get("/api/flowsheet")
        matrix = resp.json()["matrix"]

        # then
        for cat in matrix:
            for row in cat["rows"]:
                if row["id"] == "d":
                    assert row["cells"][0]["value"] == "—"

    async def test_flowsheet_same_day_biomarkers_have_unique_ids(self, client):
        # when: the seeded data has two tests on 2024-10-15 (blood-oct 09:00,
        # blood-oct-eve 14:30), so each biomarker appears twice that day
        resp = await client.get("/api/flowsheet")
        biomarkers = resp.json()["biomarkers"]

        # then: composite ids are unique per reading (no "wbc-oct-15" twice)
        ids = [b["id"] for b in biomarkers]
        assert len(ids) == len(set(ids))
        oct_ids = [i for i in ids if i.endswith("-oct-15") or "-oct-15-" in i]
        assert "wbc-oct-15" in oct_ids
        assert "wbc-oct-15-2" in oct_ids

    async def test_flowsheet_same_day_biomarkers_carry_entry_ids(self, client):
        # when
        resp = await client.get("/api/flowsheet")
        biomarkers = resp.json()["biomarkers"]

        # then: the two same-day tests are distinguishable by entry_id
        wbc_oct = [b for b in biomarkers if b["id"].startswith("wbc-oct-15")]
        assert {b["entry_id"] for b in wbc_oct} == {"blood-oct", "blood-oct-eve"}

    async def test_flowsheet_headers_dedupe_colliding_subs(self, client, db_session):
        # given: a third test on 2024-10-15 at the same 09:00 time as blood-oct
        from datetime import datetime, timezone

        from app.db.models import MedicalEntry

        db_session.add(MedicalEntry(
            id="blood-oct-dup",
            patient_id="testuser",
            type="blood_test",
            date=datetime(2024, 10, 15, 9, 0, tzinfo=timezone.utc),
            title="Duplicate Morning Panel",
        ))
        db_session.commit()

        # when
        resp = await client.get("/api/flowsheet")
        headers = resp.json()["dates"]

        # then: the two colliding 09:00 columns get (#1)/(#2) — no two columns
        # are identically labeled
        labels = [h["label"] for h in headers]
        assert len(labels) == len(set(labels))
        oct_labels = [h["label"] for h in headers if h["label"].startswith("Oct 15, 2024")]
        assert len(oct_labels) == 3
        assert any(label.endswith("(#1)") for label in oct_labels)
        assert any(label.endswith("(#2)") for label in oct_labels)


class TestBiomarkerDetail:
    async def test_get_biomarker_detail_returns_200(self, client):
        # when
        resp = await client.get("/api/biomarker/wbc")

        # then
        assert resp.status_code == 200

    async def test_biomarker_detail_resolves_occurrence_suffixed_flow_sheet_id(self, client):
        # when: the flowsheet emits "wbc-oct-15-2" for the SECOND test on
        # 2024-10-15 — the resolver must strip the "{month}-{day}-{n}" suffix
        resp = await client.get("/api/biomarker/wbc-oct-15-2")

        # then
        assert resp.status_code == 200
        assert resp.json()["id"] == "wbc"

    async def test_biomarker_detail_structure(self, client):
        # when
        resp = await client.get("/api/biomarker/wbc")
        data = resp.json()

        # then
        assert data["id"] == "wbc"
        assert "value" in data
        assert "status" in data
        assert "date" in data
        assert "definition" in data
        assert "history" in data

    async def test_biomarker_detail_history(self, client):
        # when
        resp = await client.get("/api/biomarker/wbc")
        data = resp.json()

        # then
        assert len(data["history"]) > 0
        for h in data["history"]:
            assert "date" in h
            assert "value" in h
            assert "status" in h

    async def test_biomarker_detail_404(self, client):
        # when
        resp = await client.get("/api/biomarker/nonexistent")

        # then
        assert resp.status_code == 404


class TestVisitData:
    async def test_get_visit_data_returns_200(self, client):
        # when
        resp = await client.get("/api/visit-data/cardio")

        # then
        assert resp.status_code == 200

    async def test_visit_data_fields(self, client):
        # when
        resp = await client.get("/api/visit-data/cardio")
        data = resp.json()

        # then
        assert data["specialty"] == "Cardiology Follow-up"
        assert data["provider"] == "Dr. Elena Ivanova, MD"
        assert "verdict" in data
        assert len(data["notes"]) > 0
        assert len(data["prescriptions"]) > 0
        assert len(data["recommendations"]) > 0

    async def test_visit_data_ortho(self, client):
        # when
        resp = await client.get("/api/visit-data/ortho")
        data = resp.json()

        # then
        assert data["specialty"] == "Orthopedic Consultation"
        assert len(data["attachments"]) == 0

    async def test_visit_data_404(self, client):
        # when
        resp = await client.get("/api/visit-data/nonexistent")

        # then
        assert resp.status_code == 404


class TestBiomarkerDefinitions:
    async def test_get_definitions_returns_200(self, client, auth_token):
        resp = await client.get("/api/biomarkers/definitions", headers={"Authorization": f"Bearer {auth_token}"})
        assert resp.status_code == 200

    async def test_definitions_count(self, client, auth_token):
        resp = await client.get("/api/biomarkers/definitions", headers={"Authorization": f"Bearer {auth_token}"})
        data = resp.json()
        assert len(data) == 18

    async def test_definition_has_localization_fields(self, client, auth_token):
        resp = await client.get("/api/biomarkers/definitions", headers={"Authorization": f"Bearer {auth_token}"})
        data = resp.json()
        for d in data:
            assert "names" in d
            assert "en" in d["names"]
            assert "ru" in d["names"]
            assert "es" in d["names"]
            assert "de" in d["names"]

    async def test_wbc_spanish_german_translations(self, client, auth_token):
        resp = await client.get("/api/biomarkers/definitions", headers={"Authorization": f"Bearer {auth_token}"})
        data = resp.json()
        wbc = next(d for d in data if d["id"] == "wbc")
        assert wbc["names"]["es"] == "Leucocitos"
        assert wbc["names"]["de"] == "Leukozyten"

    async def test_hemoglobin_translations(self, client, auth_token):
        resp = await client.get("/api/biomarkers/definitions", headers={"Authorization": f"Bearer {auth_token}"})
        data = resp.json()
        hb = next(d for d in data if d["id"] == "hb")
        assert hb["names"]["es"] == "Hemoglobina"
        assert hb["names"]["de"] == "Hämoglobin"

    async def test_definitions_have_correct_structure(self, client, auth_token):
        resp = await client.get("/api/biomarkers/definitions", headers={"Authorization": f"Bearer {auth_token}"})
        data = resp.json()
        for d in data:
            assert "id" in d
            assert "names" in d
            assert "synonyms" in d
            assert "loinc_code" in d
            assert "scope" in d
            assert "category" in d
            assert "unit" in d
            assert "reference" in d

    async def test_definitions_expose_canonical_unit_fields(self, client, db_session, auth_token):
        from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel

        wbc = db_session.query(BiomarkerDefinitionModel).filter(BiomarkerDefinitionModel.id == "wbc").first()
        wbc.canonical_unit = "K/uL"
        wbc.canonical_kind = "linear"
        wbc.canonical_unit_inferred = True
        db_session.commit()

        resp = await client.get("/api/biomarkers/definitions", headers={"Authorization": f"Bearer {auth_token}"})
        assert resp.status_code == 200
        data = resp.json()

        wbc_out = next(d for d in data if d["id"] == "wbc")
        assert wbc_out["canonical_unit"] == "K/uL"
        assert wbc_out["canonical_kind"] == "linear"
        assert wbc_out["canonical_unit_inferred"] is True

    async def test_definitions_unit_prefers_canonical(self, client, db_session, auth_token):
        from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel

        hb = db_session.query(BiomarkerDefinitionModel).filter(BiomarkerDefinitionModel.id == "hb").first()
        hb.canonical_unit = "g/L"
        db_session.commit()

        resp = await client.get("/api/biomarkers/definitions", headers={"Authorization": f"Bearer {auth_token}"})
        data = resp.json()
        hb_out = next(d for d in data if d["id"] == "hb")
        assert hb_out["unit"] == "g/L"
        assert hb_out["canonical_unit"] == "g/L"
