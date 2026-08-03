import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.api._serializers import (
    is_loinc,
    lookup_definition,
    reading_merged_source,
    reading_schema,
    resolve_definitions,
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
from app.db.models import (
    VisitData as VisitDataModel,
)
from app.db.session import get_db
from app.schemas import (
    Attachment as AttachmentSchema,
)
from app.schemas import (
    BiomarkerResult,
    MedicalEvent,
    Prescription,
    Reading,
    TimelineResponse,
    VisitData,
    VisitNote,
)

logger = logging.getLogger(__name__)

# Flowsheet composite ids look like "{biomarker_id}-{month}-{day}" (e.g.
# "713-8-may-26"), where the suffix is short_date_label() lowercased; tests
# that share a date label append "-{n}" to disambiguate ("wbc-oct-15-2").
# Used to recover the underlying definition id when resolving
# /api/biomarker/{id}.
_FLOW_SHEET_LABEL_RE = re.compile(
    r"-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{1,2}(?:-\d+)?$"
)

router = APIRouter()


def _events_from_db(db: Session, patient_id: str):
    # Same-day tests are ordered by insertion time then id, so the event
    # order (and therefore the timeline's default selection) is deterministic.
    entries = (
        db.query(MedicalEntryModel)
        .filter(MedicalEntryModel.patient_id == patient_id)
        .order_by(
            MedicalEntryModel.date,
            MedicalEntryModel.created_at,
            MedicalEntryModel.id,
        )
        .all()
    )
    return [
        MedicalEvent(
            id=e.id,
            type=e.type,
            date=e.date.isoformat(),
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


def _readings_query(db: Session, patient_id: str, biomarker_id: str):
    """All readings of a biomarker across the patient's blood tests, oldest first."""
    return (
        db.query(BiomarkerReading, MedicalEntryModel.date)
        .join(MedicalEntryModel, BiomarkerReading.entry_id == MedicalEntryModel.id)
        .filter(
            BiomarkerReading.biomarker_id == biomarker_id,
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


def _history_from_query(query, defn) -> list[Reading]:
    return [
        reading_schema(r, defn, date.isoformat())
        for r, date in query[:-1]
    ]


def _result_from_query(
    biomarker_id: str,
    defn: BiomarkerDefinitionModel,
    query,
) -> BiomarkerResult:
    latest_reading, latest_date = query[-1]
    return result_schema(
        id=biomarker_id,
        defn=defn,
        reading=latest_reading,
        date_label=latest_date.isoformat(),
        entry_id=latest_reading.entry_id,
        history=_history_from_query(query, defn),
        merged=bool(latest_reading.merged),
        merged_source=reading_merged_source(latest_reading),
    )


def _biomarkers_from_db(db: Session, patient_id: str):
    blood_tests = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.type == "blood_test",
            MedicalEntryModel.patient_id == patient_id,
        )
        .order_by(MedicalEntryModel.date)
        .all()
    )
    if not blood_tests:
        return []

    all_biomarker_ids: set[str] = set()
    for bt in blood_tests:
        readings = (
            db.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == bt.id)
            .all()
        )
        all_biomarker_ids.update(r.biomarker_id for r in readings)

    defn_by_id, defn_by_loinc = resolve_definitions(db, all_biomarker_ids)

    results = []
    for bid in sorted(all_biomarker_ids):
        defn = lookup_definition(defn_by_id, defn_by_loinc, bid)
        if not defn:
            logger.warning("Skipping timeline biomarker with unresolvable id=%r", bid)
            continue

        readings_query = _readings_query(db, patient_id, bid)
        if not readings_query:
            continue

        results.append(_result_from_query(bid, defn, readings_query))
    return results


def _ensure_tx(val, default="") -> dict:
    if isinstance(val, dict):
        return {"original": val.get("original", default), "translated_en": val.get("translated_en", default)}
    if isinstance(val, str):
        return {"original": val, "translated_en": val}
    return {"original": default, "translated_en": default}


def _map_note(n: dict) -> VisitNote:
    if "text" in n and "text_original" not in n:
        return VisitNote(
            heading=n.get("heading"),
            text_translated=n.get("text", ""),
            text_original=n.get("text", ""),
        )
    return VisitNote(
        heading=n.get("heading"),
        text_translated=n.get("text_translated", ""),
        text_original=n.get("text_original", ""),
    )


def _map_rx(p: dict) -> Prescription:
    if isinstance(p.get("instruction"), str):
        return Prescription(
            id=p.get("id", 0),
            name=_ensure_tx(p.get("name", "")),
            dose=_ensure_tx(p.get("dose", "")),
            instruction=_ensure_tx(p.get("instruction", "")),
        )
    return Prescription(
        id=p.get("id", 0),
        name=_ensure_tx(p.get("name", {})),
        dose=_ensure_tx(p.get("dose", {})),
        instruction=_ensure_tx(p.get("instruction", {})),
    )


def _map_rec(r) -> dict:
    if isinstance(r, str):
        return {"original": r, "translated_en": r}
    if isinstance(r, dict):
        return {"original": r.get("original", r.get("text_original", "")),
                "translated_en": r.get("translated_en", r.get("text_translated", ""))}
    return {"original": "", "translated_en": ""}


def _visits_from_db(db: Session, patient_id: str):
    visits: dict[str, VisitData] = {}
    visit_data_rows = (
        db.query(VisitDataModel, MedicalEntryModel)
        .join(MedicalEntryModel, VisitDataModel.entry_id == MedicalEntryModel.id)
        .filter(MedicalEntryModel.patient_id == patient_id)
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
            date=vd.date.isoformat() if vd.date else "",
            clinic=vd.clinic,
            verdict=_ensure_tx(vd.verdict),
            notes=[_map_note(n) for n in (vd.notes or [])],
            prescriptions=[_map_rx(p) for p in (vd.prescriptions or [])],
            recommendations=[_map_rec(r) for r in (vd.recommendations or [])],
            attachments=entry_attachments,
        )
    return visits


@router.get("/api/timeline", response_model=TimelineResponse)
async def get_timeline(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    _user, user_id, _is_anonymous = user_data
    return TimelineResponse(
        events=_events_from_db(db, user_id),
        biomarkers=_biomarkers_from_db(db, user_id),
        visits=_visits_from_db(db, user_id),
    )


@router.get("/api/biomarker/{biomarker_id}", response_model=BiomarkerResult)
async def get_biomarker_detail(
    biomarker_id: str,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    _user, user_id, _is_anonymous = user_data

    # The flowsheet passes composite ids of the form "{biomarker_id}-{date-label}"
    # (e.g. "713-8-may-26", "local-774a579f1f27-may-26"). Recover the underlying
    # definition id so flowsheet and timeline callers resolve to the same analyte.
    base_id, defn = _resolve_biomarker_base_id(db, biomarker_id)
    if defn is None:
        raise HTTPException(status_code=404, detail=f"Biomarker '{biomarker_id}' not found")

    readings_query = _readings_query(db, user_id, base_id)
    if not readings_query:
        raise HTTPException(status_code=404, detail=f"Biomarker '{biomarker_id}' not found")

    return _result_from_query(base_id, defn, readings_query)


def _resolve_biomarker_base_id(
    db: Session, biomarker_id: str
) -> tuple[str, Optional[BiomarkerDefinitionModel]]:
    """Resolve a timeline or flowsheet-style biomarker id back to the underlying
    definition. Handles plain ids, legacy LOINC codes, and the
    "{biomarker_id}-{month}-{day}" composites the flowsheet emits."""
    base_id = biomarker_id
    defn = _find_definition_by_id_or_loinc(db, base_id)
    if not defn:
        stripped = _FLOW_SHEET_LABEL_RE.sub("", base_id)
        if stripped != base_id:
            base_id = stripped
            defn = _find_definition_by_id_or_loinc(db, base_id)
    return base_id, defn


def _find_definition_by_id_or_loinc(
    db: Session, identifier: str
) -> Optional[BiomarkerDefinitionModel]:
    defn = (
        db.query(BiomarkerDefinitionModel)
        .filter(BiomarkerDefinitionModel.id == identifier)
        .first()
    )
    if not defn and is_loinc(identifier):
        defn = (
            db.query(BiomarkerDefinitionModel)
            .filter(BiomarkerDefinitionModel.loinc_code == identifier)
            .first()
        )
    return defn


@router.get("/api/visit-data/{event_id}", response_model=VisitData)
async def get_visit_data(
    event_id: str,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    _user, user_id, _is_anonymous = user_data
    entry = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.id == event_id,
            MedicalEntryModel.patient_id == user_id,
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
        date=vd.date.isoformat() if vd.date else "",
        clinic=vd.clinic,
        verdict=_ensure_tx(vd.verdict),
        notes=[_map_note(n) for n in (vd.notes or [])],
        prescriptions=[_map_rx(p) for p in (vd.prescriptions or [])],
        recommendations=[_map_rec(r) for r in (vd.recommendations or [])],
        attachments=entry_attachments,
    )
