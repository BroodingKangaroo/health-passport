import json
import os
import re
import uuid
import hashlib
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Form, UploadFile, File, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, or_

from app.schemas import SaveEntryResponse
from app.db.session import get_db
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
    BiomarkerDefinition as BiomarkerDefinitionModel,
    BiomarkerReading,
    Attachment as AttachmentModel,
    VisitData as VisitDataModel,
)
from app.mock_db import _status
from app.db.seed import DEFAULT_PATIENT_ID
from app.api._format import to_display_datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")

def _compute_status_from_range(value: float, range_str: str) -> str:
    rng = range_str.strip()
    if not rng:
        return "normal"
    lt = re.match(r"<\s*([\d.]+)", rng)
    if lt:
        return "normal" if value <= float(lt.group(1)) else "high"
    gt = re.match(r">\s*([\d.]+)", rng)
    if gt:
        return "normal" if value >= float(gt.group(1)) else "low"
    m = re.match(r"([\d.]+)\s*[–-]?\s*([\d.]+)", rng)
    if m:
        lo, hi = float(m.group(1)), float(m.group(2))
        return _status(value, lo, hi)
    return "normal"


router = APIRouter()


def _normalize_date(date_str: str, time_str: str = "") -> datetime:
    if not date_str:
        date_str = datetime.now().strftime("%Y-%m-%d")
    if time_str:
        dt = datetime.fromisoformat(f"{date_str}T{time_str}")
    else:
        dt = datetime.fromisoformat(date_str)
    return dt.replace(tzinfo=timezone.utc)


@router.get("/api/entries/by-date")
async def get_entries_by_date(
    date: str = Query(...),
    type: str = Query(""),
    db: Session = Depends(get_db),
):
    target = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
    q = db.query(MedicalEntryModel).filter(
        MedicalEntryModel.patient_id == DEFAULT_PATIENT_ID,
        func.date(MedicalEntryModel.date) == func.date(target),
    )
    if type:
        q = q.filter(MedicalEntryModel.type == type)
    return {"date": date, "count": q.count()}


@router.post("/api/entry", response_model=SaveEntryResponse)
async def save_entry(
    type: str = Form(...),
    date: str = Form(""),
    time: str = Form(""),
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
    entry_date = _normalize_date(date, time)

    entry = MedicalEntryModel(
        id=entry_id,
        patient_id=DEFAULT_PATIENT_ID,
        type=type,
        date=entry_date,
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
        saved_name = f"{uuid.uuid4().hex}{ext}"
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        save_path = os.path.join(UPLOAD_DIR, saved_name)
        content = await file.read()
        with open(save_path, "wb") as f:
            f.write(content)

        att = AttachmentModel(
            id=f"att-{entry_id}",
            entry_id=entry_id,
            name=file.filename,
            type="Uploaded Document",
            size=f"{len(content) // 1024} KB",
            file_path=f"/static/uploads/{saved_name}",
        )
        db.add(att)
        db.flush()

    if biomarkers and biomarkers != "[]":
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

                defn = (
                    db.query(BiomarkerDefinitionModel)
                    .filter(
                        or_(
                            BiomarkerDefinitionModel.name_en.ilike(name),
                            BiomarkerDefinitionModel.name_ru.ilike(name),
                        )
                    )
                    .first()
                )
                if not defn:
                    defn_id = f"auto-{hashlib.md5(name.lower().encode()).hexdigest()[:8]}"
                    defn = BiomarkerDefinitionModel(
                        id=defn_id,
                        name_en=name,
                        name_ru=name,
                        category=cat.get("name", "General"),
                        range_min=None,
                        range_max=None,
                        unit=row.get("unit", ""),
                    )
                    db.add(defn)
                    db.flush()

                derived_status = _compute_status_from_range(float_value, row.get("range", ""))

                db.add(BiomarkerReading(
                    entry_id=entry_id,
                    biomarker_id=defn.id,
                    value=float_value,
                    status=derived_status,
                    original_name=row.get("original_name"),
                    original_value=row.get("original_value"),
                    original_unit=row.get("original_unit"),
                    original_range=row.get("original_range"),
                ))
        db.flush()

    if visit_data and visit_data != "":
        vd = json.loads(visit_data)
        db.add(VisitDataModel(
            entry_id=entry_id,
            specialty=title,
            provider=provider,
            date=to_display_datetime(entry_date),
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
