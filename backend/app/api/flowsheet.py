from collections import Counter
from typing import Optional, Tuple

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
import logging

from app.schemas import (
    FlowsheetResponse,
    DateHeader,
    MatrixCategory,
    MatrixRow,
    MatrixCell,
    BiomarkerResult,
)
from app.api._serializers import (
    lookup_definition,
    result_schema,
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

    date_headers = _build_date_headers(blood_tests)

    biomarker_readings_map: dict[str, dict[str, BiomarkerReading]] = {}
    for bt in blood_tests:
        readings = (
            db.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == bt.id)
            .all()
        )
        biomarker_readings_map[bt.id] = {r.biomarker_id: r for r in readings}

    defn_by_id, defn_by_loinc = _resolve_flowsheet_definitions(db, patient_id, biomarker_readings_map)
    matrix = _build_matrix(blood_tests, biomarker_readings_map, defn_by_id, defn_by_loinc)
    biomarkers = _build_biomarker_rows(blood_tests, biomarker_readings_map, defn_by_id, defn_by_loinc)

    return date_headers, matrix, biomarkers


def _build_date_headers(blood_tests) -> list[DateHeader]:
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
    return date_headers


def _resolve_flowsheet_definitions(
    db: Session,
    patient_id: str,
    biomarker_readings_map: dict[str, dict[str, BiomarkerReading]],
) -> tuple[dict, dict]:
    """All definitions visible to the user, merged with the definitions that a
    reading references (by id OR LOINC code, regardless of owner) so a reading
    is never silently dropped."""
    all_defns = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.scope == "global")
        | (BiomarkerDefinitionModel.user_id == patient_id)
        | (BiomarkerDefinitionModel.user_id.is_(None))
    ).all()

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
    return defn_by_id, defn_by_loinc


def _all_referenced_ids(biomarker_readings_map: dict[str, dict[str, BiomarkerReading]]) -> set[str]:
    all_def_ids: set[str] = set()
    for readings in biomarker_readings_map.values():
        all_def_ids.update(readings.keys())
    return all_def_ids


def _build_matrix(
    blood_tests,
    biomarker_readings_map: dict[str, dict[str, BiomarkerReading]],
    defn_by_id: dict,
    defn_by_loinc: dict,
) -> list[MatrixCategory]:
    cat_rows: dict[str, list[MatrixRow]] = {}
    for def_id in _all_referenced_ids(biomarker_readings_map):
        defn = lookup_definition(defn_by_id, defn_by_loinc, def_id)
        if not defn:
            logger.warning("Skipping flowsheet reading with unresolvable biomarker_id=%r", def_id)
            continue
        cat = defn.category or "General"
        # Use the def's canonical English unit + kind for the column header so
        # the flowsheet is consistent across entries (the first-seen canonical
        # wins, even when later entries use a different unit / scale).
        canonical_unit = defn.canonical_unit or defn.unit
        cells = [
            _matrix_cell(def_id, bt.id, biomarker_readings_map)
            for bt in blood_tests
        ]
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
            unit=canonical_unit,
            reference=first_ref,
            canonical_unit_inferred=bool(defn.canonical_unit_inferred),
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
    return matrix


def _matrix_cell(
    def_id: str,
    entry_id: str,
    biomarker_readings_map: dict[str, dict[str, BiomarkerReading]],
) -> MatrixCell:
    reading = biomarker_readings_map.get(entry_id, {}).get(def_id)
    if reading is None:
        return MatrixCell(value="—", status="normal")
    rv = reading_value(reading)
    return MatrixCell(
        value=str(rv) if rv is not None else "—",
        status=reading.status,
        scale_function=reading.scale_function,
        needs_review=bool(reading.needs_review),
        merged=bool(reading.merged),
    )


def _build_biomarker_rows(
    blood_tests,
    biomarker_readings_map: dict[str, dict[str, BiomarkerReading]],
    defn_by_id: dict,
    defn_by_loinc: dict,
) -> list[BiomarkerResult]:
    biomarkers = []
    for bt in blood_tests:
        readings = biomarker_readings_map.get(bt.id, {})
        for def_id, reading in readings.items():
            defn = lookup_definition(defn_by_id, defn_by_loinc, def_id)
            if not defn:
                logger.warning("Skipping flowsheet reading with unresolvable biomarker_id=%r", def_id)
                continue
            label = short_date_label(bt.date).lower().replace(" ", "-")
            biomarkers.append(result_schema(
                id=f"{def_id}-{label}",
                defn=defn,
                reading=reading,
                date_label=bt.date.isoformat(),
            ))
    return biomarkers


@router.get("/api/flowsheet", response_model=FlowsheetResponse)
async def get_flowsheet(
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    user, user_id, is_anonymous = user_data
    dates, matrix, biomarkers = _build_flowsheet(db, user_id)
    return FlowsheetResponse(dates=dates, matrix=matrix, biomarkers=biomarkers)
