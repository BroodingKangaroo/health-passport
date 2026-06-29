import pytest


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
        # given
        MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        CURRENT_YEAR = 2026

        def _parse_display_date(d: str):
            parts = d.replace(" at ", " ").split()
            month = MONTHS.index(parts[0])
            day = int(parts[1].rstrip(","))
            if len(parts) == 2:
                year = CURRENT_YEAR
            elif ":" in parts[-1]:
                year = int(parts[2].rstrip(",")) if len(parts) >= 4 else CURRENT_YEAR
            else:
                year = int(parts[-1])
            return (year, month, day)

        # when
        resp = await client.get("/api/timeline")
        dates = [e["date"] for e in resp.json()["events"]]

        # then
        assert dates == sorted(dates, key=_parse_display_date)

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
            assert "name_en" in defn
            assert "name_ru" in defn
            assert "range_min" in defn
            assert "range_max" in defn
            assert "unit" in defn

    async def test_timeline_biomarker_latest_date(self, client):
        # when
        resp = await client.get("/api/timeline")
        biomarkers = resp.json()["biomarkers"]

        # then
        for b in biomarkers:
            assert b["date"] in ("Dec 03, 2026", "Jan 12, 2027")

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
        assert cardio["prescriptions"][0]["name"] == "Metoprolol Succinate"


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


class TestBiomarkerDetail:
    async def test_get_biomarker_detail_returns_200(self, client):
        # when
        resp = await client.get("/api/biomarker/wbc")

        # then
        assert resp.status_code == 200

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
