"""Full-data export endpoint (ISSUES.md F1): GET /api/export.

A read-only backup of the caller's structured data. No LLM calls, no quota
charge — export is not AI usage. JSON (default) mirrors the DB rows in a
versioned envelope; ``?format=csv`` is a long readings table for
spreadsheets. Tenant-scoped like every other endpoint: entries by
``patient_id``, local definitions by ``user_id``.
"""

import csv
import io
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app import i18n
from app.api._format import effective_reference
from app.api._serializers import lookup_definition, resolve_definitions
from app.api.auth import get_current_user_or_anon
from app.db.models import (
    BiomarkerDefinition as BiomarkerDefinitionModel,
)
from app.db.models import (
    BiomarkerReading,
    Patient,
)
from app.db.models import (
    InstrumentalData as InstrumentalDataModel,
)
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
)
from app.db.models import (
    VisitData as VisitDataModel,
)
from app.db.session import get_db
from app.services.usage_limits import get_limits

router = APIRouter(tags=["account"])

EXPORT_FORMAT_VERSION = "healthpassport-export/v1"

_CSV_COLUMNS = [
    "entry_id",
    "entry_type",
    "entry_date",
    "entry_title",
    "biomarker_id",
    "name",
    "original_name",
    "value",
    "value_text",
    "unit",
    "status",
    "reference_kind",
    "reference_low",
    "reference_high",
    "reference_expected",
    "original_value",
    "original_unit",
    "original_range",
    "scale_function",
    "needs_review",
    "merged",
]


def _display_unit(defn: BiomarkerDefinitionModel) -> str:
    return defn.canonical_unit or defn.unit


def _serialize_definition(defn: BiomarkerDefinitionModel) -> dict:
    """The caller's local definition rows, mirrored column-for-column."""
    return {
        "id": defn.id,
        "loinc_code": defn.loinc_code,
        "names": defn.names,
        "synonyms": defn.synonyms or [],
        "category": defn.category,
        "reference": defn.reference,
        "unit": defn.unit,
        "scope": defn.scope,
        "reference_source": defn.reference_source,
        "common_rank": defn.common_rank,
        "canonical_unit": defn.canonical_unit,
        "canonical_kind": defn.canonical_kind,
        "canonical_unit_inferred": bool(defn.canonical_unit_inferred),
    }


def _serialize_reading(reading: BiomarkerReading) -> dict:
    return {
        "id": reading.id,
        "biomarker_id": reading.biomarker_id,
        "value": reading.value,
        "value_text": reading.value_text,
        "reference": reading.reference,
        "status": reading.status,
        "original_name": reading.original_name or "",
        "original_value": reading.original_value or "",
        "original_unit": reading.original_unit or "",
        "original_range": reading.original_range or "",
        "scale_function": reading.scale_function,
        "needs_review": bool(reading.needs_review),
        "merged": bool(reading.merged),
        "merged_source": reading.merged_source,
    }


def _serialize_visit(vd: Optional[VisitDataModel]) -> Optional[dict]:
    if vd is None:
        return None
    return {
        "specialty": vd.specialty,
        "provider": vd.provider,
        "date": vd.date.isoformat() if vd.date else "",
        "clinic": vd.clinic,
        "verdict": vd.verdict,
        "notes": vd.notes,
        "prescriptions": vd.prescriptions,
        "recommendations": vd.recommendations,
    }


def _serialize_instrumental(idd: Optional[InstrumentalDataModel]) -> Optional[dict]:
    if idd is None:
        return None
    return {
        "modality": idd.modality or "",
        "findings": idd.findings or "",
        "conclusion": idd.conclusion or "",
    }


def _serialize_entry(entry: MedicalEntryModel) -> dict:
    return {
        "id": entry.id,
        "type": entry.type,
        "date": entry.date.isoformat(),
        "title": entry.title,
        "subtitle": entry.subtitle or "",
        "category": entry.category or "",
        "status": entry.status or "",
        "clinic": entry.clinic or "",
        "notes": entry.notes or "",
        "source_language": entry.source_language,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
        "biomarker_readings": [_serialize_reading(r) for r in entry.biomarker_readings],
        "attachments": [
            {
                "id": a.id,
                "name": a.name,
                "type": a.type,
                "size": a.size,
                "file_path": a.file_path,
            }
            for a in entry.attachments
        ],
        "visit_data": _serialize_visit(entry.visit_data),
        "instrumental_data": _serialize_instrumental(entry.instrumental_data),
    }


def _account_payload(user: Optional[Patient], user_id: str) -> dict:
    if user is not None:
        return {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "dob": user.dob or "",
            "gender": user.gender or "",
            "is_anonymous": False,
        }
    return {"id": user_id, "is_anonymous": True}


def _export_payload(db: Session, user: Optional[Patient], user_id: str, is_anonymous: bool) -> dict:
    entries = (
        db.query(MedicalEntryModel)
        .filter(MedicalEntryModel.patient_id == user_id)
        .order_by(
            MedicalEntryModel.date,
            MedicalEntryModel.created_at,
            MedicalEntryModel.id,
        )
        .all()
    )
    local_defs = (
        db.query(BiomarkerDefinitionModel)
        .filter(
            BiomarkerDefinitionModel.user_id == user_id,
            BiomarkerDefinitionModel.scope == "local",
        )
        .order_by(BiomarkerDefinitionModel.id)
        .all()
    )
    return {
        "format": EXPORT_FORMAT_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "account": _account_payload(user, user_id),
        "usage": get_limits(db, user_id, is_anonymous),
        "entries": [_serialize_entry(e) for e in entries],
        "biomarker_definitions": [_serialize_definition(d) for d in local_defs],
    }


def _csv_rows(db: Session, user_id: str) -> list[list]:
    """One row per reading across the caller's entries, joined with the
    owning entry and the reading's (possibly LOINC-legacy) definition."""
    rows = (
        db.query(BiomarkerReading, MedicalEntryModel)
        .join(MedicalEntryModel, BiomarkerReading.entry_id == MedicalEntryModel.id)
        .filter(MedicalEntryModel.patient_id == user_id)
        .order_by(
            MedicalEntryModel.date,
            MedicalEntryModel.created_at,
            MedicalEntryModel.id,
            BiomarkerReading.id,
        )
        .all()
    )
    if not rows:
        return []

    defn_by_id, defn_by_loinc = resolve_definitions(db, {r.biomarker_id for r, _ in rows})
    csv_rows: list[list] = []
    for reading, entry in rows:
        defn = lookup_definition(defn_by_id, defn_by_loinc, reading.biomarker_id)
        ref = effective_reference(reading, defn) if defn is not None else reading.reference
        if not isinstance(ref, dict):
            ref = {}
        low = ref.get("low")
        high = ref.get("high")
        expected = ref.get("expected")
        name = ""
        unit = ""
        if defn is not None:
            names = defn.names or {}
            name = names.get("en") or next(iter(names.values()), "")
            unit = _display_unit(defn)
        csv_rows.append([
            entry.id,
            entry.type,
            entry.date.isoformat(),
            entry.title,
            reading.biomarker_id,
            name,
            reading.original_name or "",
            "" if reading.value is None else reading.value,
            reading.value_text or "",
            unit,
            reading.status,
            ref.get("kind", ""),
            "" if low is None else low,
            "" if high is None else high,
            "" if expected is None else expected,
            reading.original_value or "",
            reading.original_unit or "",
            reading.original_range or "",
            reading.scale_function or "",
            "1" if reading.needs_review else "0",
            "1" if reading.merged else "0",
        ])
    return csv_rows


@router.get("/api/export")
async def export_account_data(
    format: str = "json",
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """Full structured export of the caller's data.

    ``format=json`` (default) returns the versioned backup envelope;
    ``format=csv`` returns a long readings table as a CSV attachment.
    Read-only: no LLM calls, no quota charge.
    """
    user, user_id, is_anonymous = user_data
    fmt = format.strip().lower()
    if fmt == "json":
        return _export_payload(db, user, user_id, is_anonymous)
    if fmt == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(_CSV_COLUMNS)
        for row in _csv_rows(db, user_id):
            writer.writerow(row)
        date_stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
        return Response(
            content=buffer.getvalue().encode("utf-8-sig"),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="healthpassport-readings-{date_stamp}.csv"'
                )
            },
        )
    raise HTTPException(
        status_code=400,
        detail=i18n.tr("export.invalid_format", format=format),
    )
