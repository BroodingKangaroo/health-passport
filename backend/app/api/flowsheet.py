from collections import Counter
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session
import logging

from app.schemas import (
    FlowsheetResponse,
    DateHeader,
    MatrixCategory,
    MatrixRow,
    MatrixCell,
    BiomarkerResult,
    BiomarkerDefinition as BiomarkerDefinitionSchema,
)
from app.db.session import get_db
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
    BiomarkerDefinition as BiomarkerDefinitionModel,
    BiomarkerReading,
    Patient,
)
from app.api._format import short_date_label, flowsheet_date_header, reading_value, effective_reference
from app.api.auth import get_current_user_or_anon

logger = logging.getLogger(__name__)

router = APIRouter()


def _build_flowsheet(db: Session, patient_id: str):
    blood_tests = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.type == "blood_test",
            MedicalEntryModel.patient_id == patient_id,
        )
        .order_by(MedicalEntryModel.date)
        .all()
    )

    headers = [flowsheet_date_header(e.date) for e in blood_tests]
    header_labels = [h[0] for h in headers]
    label_counts = Counter(header_labels)

    date_headers: list[DateHeader] = []
    seen: dict[str, int] = {}
    for i, e in enumerate(blood_tests):
        label, sub = headers[i]
        if label_counts[label] > 1:
            same_subs = {h[1] for h in headers if h[0] == label}
            if len(same_subs) == 1:
                seen[label] = seen.get(label, 0) + 1
                label = f"{label} (#{seen[label]})"
        date_headers.append(DateHeader(label=label, sub=sub))

    all_defns = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.scope == "global")
        | (BiomarkerDefinitionModel.user_id == patient_id)
        | (BiomarkerDefinitionModel.user_id.is_(None))
    ).all()

    biomarker_readings_map: dict[str, dict[str, BiomarkerReading]] = {}
    for bt in blood_tests:
        readings = (
            db.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == bt.id)
            .all()
        )
        biomarker_readings_map[bt.id] = {r.biomarker_id: r for r in readings}

    # A reading's biomarker_id may be a LOINC code (legacy ingestion) or may
    # reference a definition owned by another user (shared local catalog entry).
    # Resolve definitions by id AND by LOINC code, fetching any referenced
    # definition regardless of owner so the reading is never silently dropped.
    referenced_ids = set()
    for readings in biomarker_readings_map.values():
        referenced_ids.update(readings.keys())

    referenced_defns = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.id.in_(referenced_ids))
        | (BiomarkerDefinitionModel.loinc_code.in_(referenced_ids))
    ).all()

    defn_by_id = {d.id: d for d in all_defns}
    for d in referenced_defns:
        defn_by_id.setdefault(d.id, d)
    defn_by_loinc = {d.loinc_code: d for d in defn_by_id.values() if d.loinc_code}

    all_def_ids = set()
    for readings in biomarker_readings_map.values():
        all_def_ids.update(readings.keys())

    cat_rows: dict[str, list[MatrixRow]] = {}
    for def_id in all_def_ids:
        defn = defn_by_id.get(def_id) or defn_by_loinc.get(def_id)
        if not defn:
            logger.warning("Skipping flowsheet reading with unresolvable biomarker_id=%r", def_id)
            continue
        cat = defn.category or "General"
        cells = []
        for bt in blood_tests:
            reading = biomarker_readings_map.get(bt.id, {}).get(def_id)
            if reading is not None:
                rv = reading_value(reading)
                cells.append(MatrixCell(
                    value=str(rv) if rv is not None else "—",
                    status=reading.status,
                ))
            else:
                cells.append(MatrixCell(value="—", status="normal"))
        first_reading = next(
            (bt_readings.get(def_id) for bt_readings in biomarker_readings_map.values() if def_id in bt_readings),
            None,
        )
        original_name = first_reading.original_name if first_reading and first_reading.original_name else defn.names.get("ru", "")
        first_ref = effective_reference(first_reading, defn)
        cat_rows.setdefault(cat, []).append(MatrixRow(
            id=def_id,
            name=defn.names.get("en", ""),
            original=original_name,
            unit=defn.unit,
            reference=first_ref,
            cells=cells,
        ))

    seeded_order = [
        "Complete Blood Count",
        "Comprehensive Metabolic Panel",
        "Lipid Panel",
        "Iron Panel",
        "Thyroid Panel",
        "Vitamins",
    ]
    matrix = []
    for cat in seeded_order:
        if cat in cat_rows:
            rows = sorted(cat_rows.pop(cat), key=lambda r: r.name.lower())
            matrix.append(MatrixCategory(category=cat, rows=rows))
    for cat in sorted(cat_rows):
        rows = sorted(cat_rows[cat], key=lambda r: r.name.lower())
        matrix.append(MatrixCategory(category=cat, rows=rows))

    biomarkers = []
    for bt in blood_tests:
        readings = biomarker_readings_map.get(bt.id, {})
        for def_id, reading in readings.items():
            defn = defn_by_id.get(def_id) or defn_by_loinc.get(def_id)
            if not defn:
                logger.warning("Skipping flowsheet reading with unresolvable biomarker_id=%r", def_id)
                continue
            label = short_date_label(bt.date).lower().replace(" ", "-")
            biomarkers.append(BiomarkerResult(
                id=f"{def_id}-{label}",
                definition=BiomarkerDefinitionSchema(
                    id=defn.id,
                    loinc_code=defn.loinc_code,
                    names=defn.names,
                    synonyms=defn.synonyms or [],
                    category=defn.category,
                    reference=defn.reference,
                    unit=defn.unit,
                    scope=defn.scope,
                    user_id=defn.user_id,
                    reference_source=defn.reference_source,
                ),
                value=reading_value(reading),
                date=bt.date.isoformat(),
                status=reading.status,
                reference=effective_reference(reading, defn),
                original_name=reading.original_name or "",
                original_value=reading.original_value or "",
                original_unit=reading.original_unit or "",
                original_range=reading.original_range or "",
            ))

    return date_headers, matrix, biomarkers


@router.get("/api/flowsheet", response_model=FlowsheetResponse)
async def get_flowsheet(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    user, user_id, is_anonymous = user_data
    dates, matrix, biomarkers = _build_flowsheet(db, user_id)
    return FlowsheetResponse(dates=dates, matrix=matrix, biomarkers=biomarkers)
