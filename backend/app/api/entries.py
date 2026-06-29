import json
import os
import re
import uuid
from datetime import datetime as dt
from typing import Optional

from fastapi import APIRouter, Form, UploadFile, File, Depends
from sqlalchemy.orm import Session

from app.schemas import SaveEntryResponse
from app.db.session import get_db
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
    BiomarkerReading,
    Attachment as AttachmentModel,
    VisitData as VisitDataModel,
)
from app.mock_db import _status
from app.db.seed import DEFAULT_PATIENT_ID

router = APIRouter()


def _normalize_date(date_str: str) -> str:
    if re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
        parsed = dt.strptime(date_str, "%Y-%m-%d")
        return parsed.strftime("%b %d, %Y")
    return date_str


@router.post("/api/entry", response_model=SaveEntryResponse)
async def save_entry(
    type: str = Form(...),
    date: str = Form(""),
    clinic: str = Form(""),
    provider: str = Form(""),
    title: str = Form(""),
    notes: str = Form(""),
    biomarkers: str = Form("[]"),
    visit_data: str = Form(""),
    file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
):
    entry_id = uuid.uuid4().hex[:8]
    normalized_date = _normalize_date(date)

    entry = MedicalEntryModel(
        id=entry_id,
        patient_id=DEFAULT_PATIENT_ID,
        type=type,
        date=normalized_date,
        title=title or f"{type.replace('_', ' ').title()} — {date}",
        subtitle=provider,
        category="Labs" if type == "blood_test" else "",
        status="Completed",
        clinic=clinic,
        notes=notes,
    )
    db.add(entry)
    db.flush()

    if file and file.filename:
        ext = os.path.splitext(file.filename)[1]
        saved_name = f"{entry_id}{ext}"
        save_dir = os.path.join(os.path.dirname(__file__), "..", "..", "..", "frontend", "public", "uploads")
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, saved_name)
        content = await file.read()
        with open(save_path, "wb") as f:
            f.write(content)

        att = AttachmentModel(
            id=f"att-{entry_id}",
            entry_id=entry_id,
            name=file.filename,
            type="Uploaded Document",
            size=f"{len(content) // 1024} KB",
            file_path=saved_name,
        )
        db.add(att)
        db.flush()

    if biomarkers and biomarkers != "[]":
        parsed_biomarkers: dict[str, dict] = {}
        categories_data = json.loads(biomarkers)
        for cat in categories_data:
            for row in cat.get("rows", []):
                name = row.get("name", "").strip()
                raw_value = row.get("value", "").strip()
                if not name or not raw_value:
                    continue
                try:
                    float_value = float(raw_value)
                except ValueError:
                    continue

                derived_status = "normal"
                rng = row.get("range", "").strip()
                if rng:
                    m = re.match(r"([\d.]+)\s*[–-]?\s*([\d.]+)", rng)
                    if m:
                        lo, hi = float(m.group(1)), float(m.group(2))
                        derived_status = _status(float_value, lo, hi)

                db.add(BiomarkerReading(
                    entry_id=entry_id,
                    biomarker_id=row["id"],
                    value=float_value,
                    status=derived_status,
                ))
        db.flush()

    if visit_data and visit_data != "":
        vd = json.loads(visit_data)
        db.add(VisitDataModel(
            entry_id=entry_id,
            specialty=title,
            provider=provider,
            date=normalized_date,
            clinic=clinic,
            verdict=vd.get("diagnosis", ""),
            notes=[
                {"heading": "Chief Complaint & Subjective", "text": vd.get("chief_complaint", "")},
                {"heading": "Objective Findings", "text": vd.get("objective_findings", "")},
            ],
            prescriptions=[
                {"id": i + 1, "name": rx["name"], "dose": rx["dosage"], "instruction": rx["instructions"]}
                for i, rx in enumerate(vd.get("prescriptions", []))
            ],
            recommendations=[r["text"] for r in vd.get("recommendations", [])],
        ))
        db.flush()

    db.commit()
    return SaveEntryResponse(success=True, message="Entry saved", id=entry_id)
