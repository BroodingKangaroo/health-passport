import json
import os
import re
import uuid
import hashlib
from datetime import datetime, timezone
from typing import Optional, Tuple

from fastapi import APIRouter, Form, UploadFile, File, Depends, Query, HTTPException, Request, Response
from sqlalchemy.orm import Session
from sqlalchemy import cast, func, or_, String

from app.schemas import SaveEntryResponse
from app.db.session import get_db
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
    BiomarkerDefinition as BiomarkerDefinitionModel,
    BiomarkerReading,
    Attachment as AttachmentModel,
    VisitData as VisitDataModel,
    Patient,
)
from app.mock_db import _status
from app.api._format import to_display_datetime
from app.api.auth import get_current_user_or_anon
from app.services.usage_limits import check_and_record_storage_usage
from config import ANON_STORAGE_BYTES, REGISTERED_STORAGE_BYTES

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB

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
    request: Request,
    response: Response,
    date: str = Query(...),
    type: str = Query(""),
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    user, user_id, is_anonymous = user_data
    try:
        target = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date format: '{date}'. Expected ISO format (YYYY-MM-DD).")
    q = db.query(MedicalEntryModel).filter(
        MedicalEntryModel.patient_id == user_id,
        func.date(MedicalEntryModel.date) == func.date(target),
    )
    if type:
        q = q.filter(MedicalEntryModel.type == type)
    return {"date": date, "count": q.count()}


@router.post("/api/entry", response_model=SaveEntryResponse)
async def save_entry(
    request: Request,
    response: Response,
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
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    user, user_id, is_anonymous = user_data
    entry_id = uuid.uuid4().hex[:8]
    try:
        entry_date = _normalize_date(date, time)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date/time format: {e}")

    entry = MedicalEntryModel(
        id=entry_id,
        patient_id=user_id,
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
        content = await file.read()
        if len(content) > MAX_FILE_SIZE:
            raise HTTPException(status_code=413, detail=f"File too large ({len(content) // 1024} KB). Maximum allowed size is {MAX_FILE_SIZE // (1024 * 1024)} MB.")
        
        # Enforce storage quota for ALL users (anon: 50MB, registered: 200MB — see config.py).
        allowed, current_bytes, limit_bytes, remaining = check_and_record_storage_usage(
            db, user_id, len(content), is_anonymous
        )
        if not allowed:
            tier = "Anonymous" if is_anonymous else "Registered"
            raise HTTPException(
                status_code=429,
                detail=f"Storage limit reached. {tier} users can upload up to {limit_bytes // (1024*1024)}MB. Please remove old entries or contact support."
            )
        
        ext = os.path.splitext(file.filename)[1]
        saved_name = f"{uuid.uuid4().hex}{ext}"
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        save_path = os.path.join(UPLOAD_DIR, saved_name)
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
        try:
            categories_data = json.loads(biomarkers)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid biomarkers JSON format.")
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

                # 1) Lookup by definition_id (from AI pipeline)
                defn_id = row.get("definition_id")
                defn = None
                if defn_id:
                    defn = db.query(BiomarkerDefinitionModel).filter(BiomarkerDefinitionModel.id == defn_id).first()

                # 2) Fallback: fuzzy match by name using SQL ILIKE
                if not defn:
                    name_lower = name.lower()
                    # Build OR conditions for names and synonyms
                    defn = (
                        db.query(BiomarkerDefinitionModel)
                        .filter(
                            or_(
                                func.lower(BiomarkerDefinitionModel.names['en'].as_string()).ilike(name_lower),
                                func.lower(BiomarkerDefinitionModel.names['ru'].as_string()).ilike(name_lower),
                                func.lower(BiomarkerDefinitionModel.names['es'].as_string()).ilike(name_lower),
                                func.lower(BiomarkerDefinitionModel.names['de'].as_string()).ilike(name_lower),
                                func.lower(BiomarkerDefinitionModel.names['fr'].as_string()).ilike(name_lower),
                                func.lower(BiomarkerDefinitionModel.names['he'].as_string()).ilike(name_lower),
                            )
                        )
                        .first()
                    )
                    # Also check synonyms array
                    if not defn:
                        defn = (
                            db.query(BiomarkerDefinitionModel)
                            .filter(
                                func.lower(cast(BiomarkerDefinitionModel.synonyms, String)).ilike(f'%{name_lower}%')
                            )
                            .first()
                        )

                # 3) No match at all — create a local entry
                if not defn:
                    defn_id = f"local-{hashlib.md5(name.lower().encode()).hexdigest()[:12]}"
                    defn = BiomarkerDefinitionModel(
                        id=defn_id,
                        names={"en": name},
                        synonyms=[name],
                        category=cat.get("name", "General"),
                        range_min=None,
                        range_max=None,
                        unit=row.get("unit", ""),
                        scope="local",
                        user_id=user_id,
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
        try:
            vd = json.loads(visit_data)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"Invalid visit_data JSON: {e}")
        if not isinstance(vd, dict):
            raise HTTPException(status_code=400, detail="visit_data must be a JSON object")

        diagnosis = vd.get("diagnosis", {})
        chief_complaint = vd.get("chief_complaint", {})
        objective_findings = vd.get("objective_findings", {})

        notes = []
        if chief_complaint.get("translated_en") or chief_complaint.get("original"):
            notes.append({
                "heading": "Chief Complaint & Subjective",
                "text_original": chief_complaint.get("original", ""),
                "text_translated": chief_complaint.get("translated_en", ""),
            })
        if objective_findings.get("translated_en") or objective_findings.get("original"):
            notes.append({
                "heading": "Objective Findings",
                "text_original": objective_findings.get("original", ""),
                "text_translated": objective_findings.get("translated_en", ""),
            })

        def _get_tx(field, key):
            val = field.get(key) if isinstance(field, dict) else field
            return val if isinstance(val, str) else ""

        db.add(VisitDataModel(
            entry_id=entry_id,
            specialty=title or "",
            provider=provider or "",
            date=entry_date,
            clinic=clinic or "",
            verdict={
                "original": _get_tx(diagnosis, "original"),
                "translated_en": _get_tx(diagnosis, "translated_en"),
            },
            notes=notes,
            prescriptions=[
                {
                    "id": i + 1,
                    "name": {
                        "original": _get_tx(rx.get("name", {}), "original"),
                        "translated_en": _get_tx(rx.get("name", {}), "translated_en"),
                    },
                    "dose": {
                        "original": _get_tx(rx.get("dosage", {}), "original"),
                        "translated_en": _get_tx(rx.get("dosage", {}), "translated_en"),
                    },
                    "instruction": {
                        "original": _get_tx(rx.get("instructions", {}), "original"),
                        "translated_en": _get_tx(rx.get("instructions", {}), "translated_en"),
                    },
                }
                for i, rx in enumerate(vd.get("prescriptions", []))
            ],
            recommendations=[
                {
                    "text_original": _get_tx(r, "original"),
                    "text_translated": _get_tx(r, "translated_en"),
                }
                for r in vd.get("recommendations", [])
            ],
        ))
        db.flush()

    db.commit()
    return SaveEntryResponse(success=True, message="Entry saved", id=entry_id)
