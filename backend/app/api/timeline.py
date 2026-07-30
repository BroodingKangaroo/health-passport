from typing import Optional, Tuple
import logging
import re
from fastapi import APIRouter, HTTPException, Depends, Request, Response
from sqlalchemy.orm import Session

from app.api._format import reading_value, effective_reference

logger = logging.getLogger(__name__)

_LOINC_RE = re.compile(r"^\d+-\d+(\.\d+)?$")

# Flowsheet composite ids look like "{biomarker_id}-{month}-{day}" (e.g.
# "713-8-may-26"), where the suffix is short_date_label() lowercased. Used to
# recover the underlying definition id when resolving /api/biomarker/{id}.
_FLOW_SHEET_LABEL_RE = re.compile(
    r"-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{1,2}$"
)


def _is_loinc(code: Optional[str]) -> bool:
    return bool(code) and bool(_LOINC_RE.match(code))

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
    Patient,
)
from app.api.auth import get_current_user_or_anon


router = APIRouter()


def _events_from_db(db: Session, patient_id: str):
    entries = (
        db.query(MedicalEntryModel)
        .filter(MedicalEntryModel.patient_id == patient_id)
        .order_by(MedicalEntryModel.date)
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
    entry_map: dict[str, MedicalEntryModel] = {}
    for bt in blood_tests:
        entry_map[bt.id] = bt
        readings = (
            db.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == bt.id)
            .all()
        )
        all_biomarker_ids.update(r.biomarker_id for r in readings)

    referenced_defns = (
        db.query(BiomarkerDefinitionModel)
        .filter(
            (BiomarkerDefinitionModel.id.in_(all_biomarker_ids))
            | (BiomarkerDefinitionModel.loinc_code.in_(all_biomarker_ids))
        )
        .all()
    )
    defn_by_id = {d.id: d for d in referenced_defns}
    defn_by_loinc = {d.loinc_code: d for d in referenced_defns if d.loinc_code}

    results = []
    for bid in sorted(all_biomarker_ids):
        defn = defn_by_id.get(bid) or defn_by_loinc.get(bid)
        if not defn:
            logger.warning("Skipping timeline biomarker with unresolvable id=%r", bid)
            continue

        readings_query = (
            db.query(BiomarkerReading, MedicalEntryModel.date)
            .join(MedicalEntryModel, BiomarkerReading.entry_id == MedicalEntryModel.id)
            .filter(
                BiomarkerReading.biomarker_id == bid,
                MedicalEntryModel.type == "blood_test",
                MedicalEntryModel.patient_id == patient_id,
            )
            .order_by(MedicalEntryModel.date)
            .all()
        )

        if not readings_query:
            continue

        latest_reading, latest_date = readings_query[-1]
        history = [
            Reading(
                date=date.isoformat(), value=reading_value(r), status=r.status,
                reference=effective_reference(r, defn),
                original_name=r.original_name or "",
                original_value=r.original_value or "",
                original_unit=r.original_unit or "",
                original_range=r.original_range or "",
                scale_function=getattr(r, "scale_function", None),
                needs_review=bool(getattr(r, "needs_review", False)),
            )
            for r, date in readings_query[:-1]
        ]

        results.append(BiomarkerResult(
            id=bid,
            definition=BiomarkerDefinitionSchema(
                id=defn.id,
                loinc_code=defn.loinc_code,
                names=defn.names,
                synonyms=defn.synonyms or [],
                category=defn.category,
                reference=defn.reference,
                unit=getattr(defn, "canonical_unit", None) or defn.unit,
                scope=defn.scope,
                user_id=defn.user_id,
                reference_source=defn.reference_source,
                canonical_unit=getattr(defn, "canonical_unit", None),
                canonical_kind=getattr(defn, "canonical_kind", None),
                canonical_unit_inferred=bool(getattr(defn, "canonical_unit_inferred", False)),
            ),
            value=reading_value(latest_reading),
            date=latest_date.isoformat(),
            status=latest_reading.status,
            history=history,
            reference=effective_reference(latest_reading, defn),
            original_name=latest_reading.original_name or "",
            original_value=latest_reading.original_value or "",
            original_unit=latest_reading.original_unit or "",
            original_range=latest_reading.original_range or "",
        ))
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
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    user, user_id, is_anonymous = user_data
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
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    user, user_id, is_anonymous = user_data

    # The flowsheet passes composite ids of the form "{biomarker_id}-{date-label}"
    # (e.g. "713-8-may-26", "local-774a579f1f27-may-26"). Recover the underlying
    # definition id so flowsheet and timeline callers resolve to the same analyte.
    base_id = biomarker_id
    defn = (
        db.query(BiomarkerDefinitionModel)
        .filter(BiomarkerDefinitionModel.id == base_id)
        .first()
    )
    if not defn and _is_loinc(base_id):
        defn = (
            db.query(BiomarkerDefinitionModel)
            .filter(BiomarkerDefinitionModel.loinc_code == base_id)
            .first()
        )
    if not defn:
        stripped = _FLOW_SHEET_LABEL_RE.sub("", base_id)
        if stripped != base_id:
            base_id = stripped
            defn = (
                db.query(BiomarkerDefinitionModel)
                .filter(BiomarkerDefinitionModel.id == base_id)
                .first()
            )
            if not defn and _is_loinc(base_id):
                defn = (
                    db.query(BiomarkerDefinitionModel)
                    .filter(BiomarkerDefinitionModel.loinc_code == base_id)
                    .first()
                )
    if not defn:
        raise HTTPException(status_code=404, detail=f"Biomarker '{biomarker_id}' not found")

    readings_query = (
        db.query(BiomarkerReading, MedicalEntryModel.date)
        .join(MedicalEntryModel, BiomarkerReading.entry_id == MedicalEntryModel.id)
        .filter(
            BiomarkerReading.biomarker_id == base_id,
            MedicalEntryModel.type == "blood_test",
            MedicalEntryModel.patient_id == user_id,
        )
        .order_by(MedicalEntryModel.date)
        .all()
    )
    if not readings_query:
        raise HTTPException(status_code=404, detail=f"Biomarker '{biomarker_id}' not found")

    latest_reading, latest_date = readings_query[-1]
    history = [
        Reading(
            date=date.isoformat(), value=reading_value(r), status=r.status,
            reference=effective_reference(r, defn),
            original_name=r.original_name or "",
            original_value=r.original_value or "",
            original_unit=r.original_unit or "",
            original_range=r.original_range or "",
            scale_function=getattr(r, "scale_function", None),
            needs_review=bool(getattr(r, "needs_review", False)),
        )
        for r, date in readings_query[:-1]
    ]
    return BiomarkerResult(
        id=base_id,
        definition=BiomarkerDefinitionSchema(
            id=defn.id,
            loinc_code=defn.loinc_code,
            names=defn.names,
            synonyms=defn.synonyms or [],
            category=defn.category,
            reference=defn.reference,
            unit=getattr(defn, "canonical_unit", None) or defn.unit,
            scope=defn.scope,
            user_id=defn.user_id,
            reference_source=defn.reference_source,
            canonical_unit=getattr(defn, "canonical_unit", None),
            canonical_kind=getattr(defn, "canonical_kind", None),
            canonical_unit_inferred=bool(getattr(defn, "canonical_unit_inferred", False)),
        ),
        value=reading_value(latest_reading),
        date=latest_date.isoformat(),
        status=latest_reading.status,
        history=history,
        reference=effective_reference(latest_reading, defn),
        original_name=latest_reading.original_name or "",
        original_value=latest_reading.original_value or "",
        original_unit=latest_reading.original_unit or "",
        original_range=latest_reading.original_range or "",
    )


@router.get("/api/visit-data/{event_id}", response_model=VisitData)
async def get_visit_data(
    event_id: str,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    user, user_id, is_anonymous = user_data
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
