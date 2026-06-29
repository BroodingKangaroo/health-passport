from collections import Counter

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

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
)
from app.mock_db import CATEGORY_GROUPING
from app.db.seed import DEFAULT_PATIENT_ID
from app.api._format import to_display_datetime, short_date_label, flowsheet_date_header

router = APIRouter()


def _build_flowsheet(db: Session):
    blood_tests = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.type == "blood_test",
            MedicalEntryModel.patient_id == DEFAULT_PATIENT_ID,
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

    all_defns = db.query(BiomarkerDefinitionModel).all()
    defn_map = {d.id: d for d in all_defns}

    biomarker_readings_map: dict[str, dict[str, BiomarkerReading]] = {}
    for bt in blood_tests:
        readings = (
            db.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == bt.id)
            .all()
        )
        biomarker_readings_map[bt.id] = {r.biomarker_id: r for r in readings}

    matrix = []
    for cat_name, def_ids in CATEGORY_GROUPING.items():
        rows = []
        for def_id in def_ids:
            defn = defn_map.get(def_id)
            if not defn:
                continue
            cells = []
            for bt in blood_tests:
                reading = biomarker_readings_map.get(bt.id, {}).get(def_id)
                if reading is not None:
                    cells.append(MatrixCell(
                        value=str(reading.value),
                        status=reading.status,
                    ))
                else:
                    cells.append(MatrixCell(value="—", status="normal"))
            rows.append(MatrixRow(
                id=def_id,
                name=defn.name_en,
                original=defn.name_ru,
                range=f"{defn.range_min} – {defn.range_max} {defn.unit}",
                cells=cells,
            ))
        matrix.append(MatrixCategory(category=cat_name, rows=rows))

    biomarkers = []
    for bt in blood_tests:
        readings = biomarker_readings_map.get(bt.id, {})
        for def_id, reading in readings.items():
            defn = defn_map.get(def_id)
            if not defn:
                continue
            label = short_date_label(bt.date).lower().replace(" ", "-")
            biomarkers.append(BiomarkerResult(
                id=f"{def_id}-{label}",
                definition=BiomarkerDefinitionSchema(
                    id=defn.id,
                    name_en=defn.name_en,
                    name_ru=defn.name_ru,
                    category=defn.category,
                    range_min=defn.range_min,
                    range_max=defn.range_max,
                    unit=defn.unit,
                ),
                value=reading.value,
                date=to_display_datetime(bt.date),
                status=reading.status,
            ))

    return date_headers, matrix, biomarkers


@router.get("/api/flowsheet", response_model=FlowsheetResponse)
async def get_flowsheet(db: Session = Depends(get_db)):
    dates, matrix, biomarkers = _build_flowsheet(db)
    return FlowsheetResponse(dates=dates, matrix=matrix, biomarkers=biomarkers)
