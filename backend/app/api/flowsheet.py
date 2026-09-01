import logging
from collections import Counter
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api._format import (
    effective_reference,
    flowsheet_date_header,
    reading_value,
    short_date_label,
)
from app.api._serializers import (
    lookup_definition,
    result_schema,
)
from app.api.auth import get_current_user_or_anon
from app.db.models import (
    BiomarkerDefinition as BiomarkerDefinitionModel,
)
from app.db.models import (
    BiomarkerReading,
    Patient,
)
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
)
from app.db.session import get_db
from app.schemas import (
    BiomarkerResult,
    DateHeader,
    FlowsheetResponse,
    MatrixCategory,
    MatrixCell,
    MatrixRow,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _build_flowsheet(db: Session, patient_id: str):
    blood_tests = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.type == "blood_test",
            MedicalEntryModel.patient_id == patient_id,
        )
        .order_by(
            MedicalEntryModel.date,
            MedicalEntryModel.created_at,
            MedicalEntryModel.id,
        )
        .all()
    )

    date_headers = _build_date_headers(blood_tests)

    # One batched query instead of one per entry (ISSUES.md #59); per-entry
    # dict shape and last-wins semantics preserved.
    all_readings = (
        db.query(BiomarkerReading)
        .filter(BiomarkerReading.entry_id.in_([bt.id for bt in blood_tests]))
        .order_by(BiomarkerReading.id)
        .all()
    )
    readings_by_entry: dict[str, list[BiomarkerReading]] = {}
    for r in all_readings:
        readings_by_entry.setdefault(r.entry_id, []).append(r)
    biomarker_readings_map: dict[str, dict[str, BiomarkerReading]] = {
        bt.id: {r.biomarker_id: r for r in readings_by_entry.get(bt.id, [])}
        for bt in blood_tests
    }

    defn_by_id, defn_by_loinc = _resolve_flowsheet_definitions(db, patient_id, biomarker_readings_map)
    matrix = _build_matrix(blood_tests, biomarker_readings_map, defn_by_id, defn_by_loinc)
    biomarkers = _build_biomarker_rows(blood_tests, biomarker_readings_map, defn_by_id, defn_by_loinc)

    return date_headers, matrix, biomarkers


def _build_date_headers(blood_tests) -> list[DateHeader]:
    """Build one column header per blood test. Same-day tests are told apart
    by their time sub-label; when two columns would otherwise be identical
    (same label AND same sub — e.g. several untimed tests on one day), a
    "(#n)" suffix disambiguates each occurrence of that colliding pair."""
    headers = [flowsheet_date_header(e.date) for e in blood_tests]
    pair_counts = Counter(headers)
    seen: dict[tuple[str, Optional[str]], int] = {}
    date_headers: list[DateHeader] = []
    for entry, (label, sub) in zip(blood_tests, headers):
        if pair_counts[(label, sub)] > 1:
            seen[(label, sub)] = seen.get((label, sub), 0) + 1
            label = f"{label} (#{seen[(label, sub)]})"
        date_headers.append(DateHeader(label=label, sub=sub, source_language=entry.source_language))
    return date_headers


def _resolve_flowsheet_definitions(
    db: Session,
    patient_id: str,
    biomarker_readings_map: dict[str, dict[str, BiomarkerReading]],
) -> tuple[dict, dict]:
    """All definitions visible to the user, merged with the definitions that a
    reading references (by id OR LOINC code) among those same visible defs so a
    reading is never silently dropped. Foreign (other-tenant) local defs are
    excluded: they would leak owner ids into the matrix."""
    all_defns = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.scope == "global")
        | (BiomarkerDefinitionModel.user_id == patient_id)
        | (BiomarkerDefinitionModel.user_id.is_(None))
    ).all()

    visible = (
        (BiomarkerDefinitionModel.scope == "global")
        | (BiomarkerDefinitionModel.user_id == patient_id)
        | (BiomarkerDefinitionModel.user_id.is_(None))
    )
    referenced_ids = set()
    for readings in biomarker_readings_map.values():
        referenced_ids.update(readings.keys())
    referenced_defns = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.id.in_(referenced_ids))
        | (BiomarkerDefinitionModel.loinc_code.in_(referenced_ids)),
        visible,
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
    entry_language = {bt.id: bt.source_language for bt in blood_tests}
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
            (
                readings.get(def_id)
                for entry_id, readings in biomarker_readings_map.items()
                if def_id in readings
            ),
            None,
        )
        original_name = (first_reading.original_name if first_reading else "") or ""
        original_lang = (
            entry_language.get(first_reading.entry_id) if first_reading else None
        )
        first_ref = effective_reference(first_reading, defn)
        cat_rows.setdefault(cat, []).append(MatrixRow(
            id=def_id,
            name=defn.names.get("en", ""),
            original=original_name,
            original_lang=original_lang,
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
    # The composite id suffix drops the year ("may-26"), so two tests from
    # different years can share a label — every repeat occurrence gets a
    # "-{n}" suffix so the emitted ids are unique per reading and stay
    # resolvable by /api/biomarker/{id} (the resolver strips
    # "{month}-{day}[-{n}]").
    label_seen: dict[str, int] = {}

    biomarkers = []
    for bt in blood_tests:
        label = short_date_label(bt.date).lower().replace(" ", "-")
        label_seen[label] = label_seen.get(label, 0) + 1
        # First occurrence keeps the legacy plain id; repeats get a suffix.
        id_label = f"{label}-{label_seen[label]}" if label_seen[label] > 1 else label
        readings = biomarker_readings_map.get(bt.id, {})
        for def_id, reading in readings.items():
            defn = lookup_definition(defn_by_id, defn_by_loinc, def_id)
            if not defn:
                logger.warning("Skipping flowsheet reading with unresolvable biomarker_id=%r", def_id)
                continue
            biomarkers.append(result_schema(
                id=f"{def_id}-{id_label}",
                defn=defn,
                reading=reading,
                date_label=bt.date.isoformat(),
                entry_id=bt.id,
            ))
    return biomarkers


@router.get("/api/flowsheet", response_model=FlowsheetResponse)
async def get_flowsheet(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    _user, user_id, _is_anonymous = user_data
    dates, matrix, biomarkers = _build_flowsheet(db, user_id)
    return FlowsheetResponse(dates=dates, matrix=matrix, biomarkers=biomarkers)
