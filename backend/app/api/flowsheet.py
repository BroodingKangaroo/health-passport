from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.schemas import (
    FlowsheetResponse,
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

router = APIRouter()


def _parse_date(date_str: str):
    return datetime.strptime(date_str, "%b %d, %Y").timetuple()[:3]


def _build_flowsheet(db: Session):
    blood_tests = sorted(
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.type == "blood_test",
            MedicalEntryModel.patient_id == DEFAULT_PATIENT_ID,
        )
        .all(),
        key=lambda e: _parse_date(e.date),
    )

    date_labels = [e.date.split(",")[0] for e in blood_tests]

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
            label = bt.date.split(",")[0].lower().replace(" ", "-")
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
                date=bt.date,
                status=reading.status,
            ))

    return date_labels, matrix, biomarkers


@router.get("/api/flowsheet", response_model=FlowsheetResponse)
async def get_flowsheet(db: Session = Depends(get_db)):
    dates, matrix, biomarkers = _build_flowsheet(db)
    return FlowsheetResponse(dates=dates, matrix=matrix, biomarkers=biomarkers)
