from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.orm import Session

from app.schemas import (
    TimelineResponse,
    MedicalEvent,
    BiomarkerResult,
    BiomarkerDefinition as BiomarkerDefinitionSchema,
    VisitData,
    VisitNote,
    Prescription,
    Attachment as AttachmentSchema,
    Reading,
)
from app.db.session import get_db
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
    BiomarkerDefinition as BiomarkerDefinitionModel,
    BiomarkerReading,
    VisitData as VisitDataModel,
    Attachment as AttachmentModel,
)
from app.db.seed import DEFAULT_PATIENT_ID
from app.api._format import to_display_datetime

router = APIRouter()


def _events_from_db(db: Session):
    entries = (
        db.query(MedicalEntryModel)
        .filter(MedicalEntryModel.patient_id == DEFAULT_PATIENT_ID)
        .order_by(MedicalEntryModel.date)
        .all()
    )
    return [
        MedicalEvent(
            id=e.id,
            type=e.type,
            date=to_display_datetime(e.date),
            title=e.title,
            subtitle=e.subtitle or "",
            category=e.category or "",
            status=e.status or "",
            clinic=e.clinic or "",
            attachments=[
                AttachmentSchema(id=a.id, name=a.name, type=a.type, size=a.size, url=a.file_path)
                for a in e.attachments
            ],
        )
        for e in entries
    ]


def _biomarkers_from_db(db: Session):
    blood_tests = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.type == "blood_test",
            MedicalEntryModel.patient_id == DEFAULT_PATIENT_ID,
        )
        .order_by(MedicalEntryModel.date)
        .all()
    )
    if not blood_tests:
        return []

    all_biomarker_ids: set[str] = set()
    entry_map: dict[str, MedicalEntryModel] = {}
    for bt in blood_tests:
        entry_map[bt.id] = bt
        readings = (
            db.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == bt.id)
            .all()
        )
        all_biomarker_ids.update(r.biomarker_id for r in readings)

    results = []
    for bid in sorted(all_biomarker_ids):
        defn = (
            db.query(BiomarkerDefinitionModel)
            .filter(BiomarkerDefinitionModel.id == bid)
            .first()
        )
        if not defn:
            continue

        readings_query = (
            db.query(BiomarkerReading, MedicalEntryModel.date)
            .join(MedicalEntryModel, BiomarkerReading.entry_id == MedicalEntryModel.id)
            .filter(
                BiomarkerReading.biomarker_id == bid,
                MedicalEntryModel.type == "blood_test",
                MedicalEntryModel.patient_id == DEFAULT_PATIENT_ID,
            )
            .order_by(MedicalEntryModel.date)
            .all()
        )

        if not readings_query:
            continue

        latest_reading, latest_date = readings_query[-1]
        history = [
            Reading(date=to_display_datetime(date), value=r.value, status=r.status)
            for r, date in readings_query[:-1]
        ]

        results.append(BiomarkerResult(
            id=bid,
            definition=BiomarkerDefinitionSchema(
                id=defn.id,
                name_en=defn.name_en,
                name_ru=defn.name_ru,
                category=defn.category,
                range_min=defn.range_min,
                range_max=defn.range_max,
                unit=defn.unit,
            ),
            value=latest_reading.value,
            date=to_display_datetime(latest_date),
            status=latest_reading.status,
            history=history,
        ))
    return results


def _visits_from_db(db: Session):
    visits: dict[str, VisitData] = {}
    visit_data_rows = (
        db.query(VisitDataModel, MedicalEntryModel)
        .join(MedicalEntryModel, VisitDataModel.entry_id == MedicalEntryModel.id)
        .filter(MedicalEntryModel.patient_id == DEFAULT_PATIENT_ID)
        .all()
    )
    for vd, entry in visit_data_rows:
        entry_attachments = [
            AttachmentSchema(id=a.id, name=a.name, type=a.type, size=a.size, url=a.file_path)
            for a in entry.attachments
        ]
        visits[entry.id] = VisitData(
            specialty=vd.specialty,
            provider=vd.provider,
            date=vd.date,
            clinic=vd.clinic,
            verdict=vd.verdict,
            notes=[VisitNote(**n) for n in (vd.notes or [])],
            prescriptions=[Prescription(**p) for p in (vd.prescriptions or [])],
            recommendations=vd.recommendations or [],
            attachments=entry_attachments,
        )
    return visits


@router.get("/api/timeline", response_model=TimelineResponse)
async def get_timeline(db: Session = Depends(get_db)):
    return TimelineResponse(
        events=_events_from_db(db),
        biomarkers=_biomarkers_from_db(db),
        visits=_visits_from_db(db),
    )


@router.get("/api/biomarker/{biomarker_id}", response_model=BiomarkerResult)
async def get_biomarker_detail(biomarker_id: str, db: Session = Depends(get_db)):
    defn = (
        db.query(BiomarkerDefinitionModel)
        .filter(BiomarkerDefinitionModel.id == biomarker_id)
        .first()
    )
    if not defn:
        raise HTTPException(status_code=404, detail=f"Biomarker '{biomarker_id}' not found")

    readings_query = (
        db.query(BiomarkerReading, MedicalEntryModel.date)
        .join(MedicalEntryModel, BiomarkerReading.entry_id == MedicalEntryModel.id)
        .filter(
            BiomarkerReading.biomarker_id == biomarker_id,
            MedicalEntryModel.type == "blood_test",
            MedicalEntryModel.patient_id == DEFAULT_PATIENT_ID,
        )
        .order_by(MedicalEntryModel.date)
        .all()
    )
    if not readings_query:
        raise HTTPException(status_code=404, detail=f"Biomarker '{biomarker_id}' not found")

    latest_reading, latest_date = readings_query[-1]
    history = [
        Reading(date=to_display_datetime(date), value=r.value, status=r.status)
        for r, date in readings_query[:-1]
    ]
    return BiomarkerResult(
        id=biomarker_id,
        definition=BiomarkerDefinitionSchema(
            id=defn.id,
            name_en=defn.name_en,
            name_ru=defn.name_ru,
            category=defn.category,
            range_min=defn.range_min,
            range_max=defn.range_max,
            unit=defn.unit,
        ),
        value=latest_reading.value,
        date=to_display_datetime(latest_date),
        status=latest_reading.status,
        history=history,
    )


@router.get("/api/visit-data/{event_id}", response_model=VisitData)
async def get_visit_data(event_id: str, db: Session = Depends(get_db)):
    entry = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.id == event_id,
            MedicalEntryModel.patient_id == DEFAULT_PATIENT_ID,
        )
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail=f"Visit '{event_id}' not found")
    vd = (
        db.query(VisitDataModel)
        .filter(VisitDataModel.entry_id == event_id)
        .first()
    )
    if not vd:
        raise HTTPException(status_code=404, detail=f"Visit '{event_id}' not found")
    entry_attachments = [
        AttachmentSchema(id=a.id, name=a.name, type=a.type, size=a.size, url=a.file_path)
        for a in entry.attachments
    ]
    return VisitData(
        specialty=vd.specialty,
        provider=vd.provider,
        date=vd.date,
        clinic=vd.clinic,
        verdict=vd.verdict,
        notes=[VisitNote(**n) for n in (vd.notes or [])],
        prescriptions=[Prescription(**p) for p in (vd.prescriptions or [])],
        recommendations=vd.recommendations or [],
        attachments=entry_attachments,
    )
