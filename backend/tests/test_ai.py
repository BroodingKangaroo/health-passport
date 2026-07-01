import json
from unittest.mock import patch

from app.schemas.ai import (
    RawMedicalRecord,
    RawBiomarker,
    RawVisitData,
    RawImagingData,
    StandardizedMedicalRecord,
    StandardizedBiomarker,
)


class TestExtractEndpoint:
    @patch("app.api.ai.matcher.match_and_convert")
    @patch("app.api.ai.extractor.extract_raw")
    async def test_extract_blood_test_success(self, mock_extract, mock_match, client, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")

        raw = RawMedicalRecord(
            entry_type="blood_test",
            date="2026-06-15",
            clinic="Invitro Lab",
            provider="Dr. Ivanova",
            biomarkers=[
                RawBiomarker(name="Гемоглобин", value="142", unit="г/л", raw_range_string="130-170", category="Общий анализ крови"),
                RawBiomarker(name="Лейкоциты", value="6.5", unit="K/µL", raw_range_string="4.0-11.0", category="Общий анализ крови"),
            ],
        )
        mock_extract.return_value = raw

        std = StandardizedMedicalRecord(
            entry_type="blood_test",
            date="2026-06-15",
            clinic="Invitro Lab",
            provider="Dr. Ivanova",
            biomarkers=[
                StandardizedBiomarker(
                    raw_name="Гемоглобин", raw_value="142", raw_unit="г/л", raw_range_string="130-170",
                    standard_name_en="Hemoglobin", standard_value=142.0, standard_unit="g/L",
                    standard_range_min=130.0, standard_range_max=170.0,
                    status="normal", category="Complete Blood Count",
                ),
                StandardizedBiomarker(
                    raw_name="Лейкоциты", raw_value="6.5", raw_unit="K/µL", raw_range_string="4.0-11.0",
                    standard_name_en="WBC", standard_value=6.5, standard_unit="K/µL",
                    standard_range_min=4.0, standard_range_max=11.0,
                    status="normal", category="Complete Blood Count",
                ),
            ],
        )
        mock_match.return_value = std

        resp = await client.post(
            "/api/extract",
            files={"file": ("lab.pdf", b"fake pdf content", "application/pdf")},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["entry_type"] == "blood_test"
        assert data["date"] == "2026-06-15"
        assert data["clinic"] == "Invitro Lab"
        assert len(data["biomarkers"]) == 2
        assert data["biomarkers"][0]["standard_name_en"] == "Hemoglobin"
        assert data["biomarkers"][0]["standard_value"] == 142.0
        assert data["biomarkers"][0]["raw_name"] == "Гемоглобин"
        assert data["biomarkers"][0]["standard_range_min"] == 130.0
        assert data["biomarkers"][0]["standard_range_max"] == 170.0
        assert data["biomarkers"][0]["status"] == "normal"
        assert data["biomarkers"][1]["standard_name_en"] == "WBC"
        assert data["biomarkers"][1]["standard_value"] == 6.5

    @patch("app.api.ai.matcher.match_and_convert")
    @patch("app.api.ai.extractor.extract_raw")
    async def test_extract_doctor_visit_success(self, mock_extract, mock_match, client, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")

        raw = RawMedicalRecord(
            entry_type="doctor_visit",
            date="2026-06-10",
            clinic="City Hospital",
            provider="Dr. Smith",
            visit_data=RawVisitData(
                diagnosis="Hypertension",
                chief_complaint="Headaches for 2 weeks",
                objective_findings="BP 150/95, heart rate normal",
            ),
        )
        mock_extract.return_value = raw

        std = StandardizedMedicalRecord(
            entry_type="doctor_visit",
            date="2026-06-10",
            clinic="City Hospital",
            provider="Dr. Smith",
            visit_data=raw.visit_data,
        )
        mock_match.return_value = std

        resp = await client.post(
            "/api/extract",
            files={"file": ("visit.pdf", b"fake visit content", "application/pdf")},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["entry_type"] == "doctor_visit"
        assert data["visit_data"]["diagnosis"] == "Hypertension"

    @patch("app.api.ai.matcher.match_and_convert")
    @patch("app.api.ai.extractor.extract_raw")
    async def test_extract_imaging_success(self, mock_extract, mock_match, client, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")

        raw = RawMedicalRecord(
            entry_type="imaging",
            date="2026-06-20",
            clinic="Radiology Center",
            provider="Dr. Jones",
            imaging_data=RawImagingData(
                modality="MRI",
                findings="Mild disc degeneration at L4-L5",
                conclusion="Minor age-related changes, no acute pathology",
            ),
        )
        mock_extract.return_value = raw

        std = StandardizedMedicalRecord(
            entry_type="imaging",
            date="2026-06-20",
            clinic="Radiology Center",
            provider="Dr. Jones",
            imaging_data=raw.imaging_data,
        )
        mock_match.return_value = std

        resp = await client.post(
            "/api/extract",
            files={"file": ("mri.pdf", b"fake mri content", "application/pdf")},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["entry_type"] == "imaging"
        assert data["imaging_data"]["modality"] == "MRI"
        assert "L4-L5" in data["imaging_data"]["findings"]

    async def test_extract_unsupported_file_type(self, client, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")

        resp = await client.post(
            "/api/extract",
            files={"file": ("notes.txt", b"some text", "text/plain")},
        )

        assert resp.status_code == 400
        data = resp.json()
        assert "Unsupported file type" in data["detail"]

    async def test_extract_empty_file(self, client, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")

        resp = await client.post(
            "/api/extract",
            files={"file": ("empty.pdf", b"", "application/pdf")},
        )

        assert resp.status_code == 400
        data = resp.json()
        assert "Empty file" in data["detail"]

    @patch("app.api.ai.extractor.extract_raw")
    async def test_extract_ocr_failure(self, mock_extract, client, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        mock_extract.side_effect = Exception("OCR service unavailable")

        resp = await client.post(
            "/api/extract",
            files={"file": ("lab.pdf", b"fake content", "application/pdf")},
        )

        assert resp.status_code == 502
        data = resp.json()
        assert "OCR processing failed" in data["detail"]

    @patch("app.api.ai.extractor.extract_raw")
    async def test_extract_chat_fallback_on_parse_error(self, mock_extract, client, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        mock_extract.return_value = RawMedicalRecord(
            entry_type="unknown",
            notes="Raw OCR text:\n\nSome lab result text\nGlucose: 95 mg/dL",
        )

        resp = await client.post(
            "/api/extract",
            files={"file": ("lab.pdf", b"fake content", "application/pdf")},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["entry_type"] == "unknown"
        assert "Raw OCR text" in data["notes"]

    async def test_extract_no_api_key(self, client):
        resp = await client.post(
            "/api/extract",
            files={"file": ("lab.pdf", b"fake content", "application/pdf")},
        )

        assert resp.status_code == 500
        data = resp.json()
        assert "MISTRAL_API_KEY not configured" in data["detail"]

    @patch("app.api.ai.matcher.match_and_convert")
    @patch("app.api.ai.extractor.extract_raw")
    async def test_extract_allowed_extensions(self, mock_extract, mock_match, client, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")

        raw = RawMedicalRecord(entry_type="blood_test")
        mock_extract.return_value = raw

        std = StandardizedMedicalRecord(entry_type="blood_test")
        mock_match.return_value = std

        for filename in ("scan.jpg", "scan.jpeg", "scan.png", "scan.tiff", "scan.tif", "scan.bmp"):
            resp = await client.post(
                "/api/extract",
                files={"file": (filename, b"fake content", "application/octet-stream")},
            )
            assert resp.status_code == 200, f"Failed for {filename}"
