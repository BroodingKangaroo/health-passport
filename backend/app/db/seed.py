from datetime import datetime, timezone

from app.db.models import (
    Patient,
    BiomarkerDefinition,
    MedicalEntry,
    BiomarkerReading,
    Attachment,
    VisitData,
)
from app.mock_db import (
    BIOMARKER_DEFINITIONS,
    BLOOD_TEST_IDS,
    BLOOD_TEST_DATES,
    BLOOD_TEST_TITLES,
    BLOOD_TEST_SUBTITLES,
    BLOOD_TEST_CLINICS,
    BLOOD_ATTACHMENTS,
    DOCTOR_VISITS,
    PROCEDURES,
    _build_biomarkers_for_date,
)

DEFAULT_PATIENT_ID = "default"


def _seed_patient(db) -> None:
    if db.query(Patient).filter(Patient.id == DEFAULT_PATIENT_ID).first():
        return
    db.add(Patient(
        id=DEFAULT_PATIENT_ID,
        name="Alexey Ivanov",
        dob="1988-03-14",
        gender="Male",
        external_id="HP-2026-04417",
    ))
    db.flush()


def _seed_biomarker_definitions(db) -> None:
    existing = {r.id for r in db.query(BiomarkerDefinition.id).all()}
    for bid, defn in BIOMARKER_DEFINITIONS.items():
        if bid not in existing:
            db.add(BiomarkerDefinition(
                id=bid,
                name_en=defn["name_en"],
                name_ru=defn["name_ru"],
                category=defn["category"],
                range_min=defn["range_min"],
                range_max=defn["range_max"],
                unit=defn["unit"],
            ))
    db.flush()


def _seed_blood_tests(db) -> None:
    existing = {r.id for r in db.query(MedicalEntry.id).all()}
    for i, eid in enumerate(BLOOD_TEST_IDS):
        if eid in existing:
            continue
        biomarkers = _build_biomarkers_for_date(i)
        if eid == "blood-feb":
            for k in ["iron", "ferritin", "tibc", "tsh", "t4", "b12", "d"]:
                biomarkers.pop(k, None)
        if eid == "blood-sep":
            for k in ["ldl", "hdl", "trig", "iron", "ferritin", "tibc"]:
                biomarkers.pop(k, None)
        if eid == "blood-jan":
            for k in ["b12", "d"]:
                biomarkers.pop(k, None)
        entry = MedicalEntry(
            id=eid,
            patient_id=DEFAULT_PATIENT_ID,
            type="blood_test",
            date=datetime.fromisoformat(BLOOD_TEST_DATES[i]).replace(tzinfo=timezone.utc),
            title=BLOOD_TEST_TITLES[i],
            subtitle=BLOOD_TEST_SUBTITLES[i],
            category="Labs",
            status="Completed",
            clinic=BLOOD_TEST_CLINICS[i],
        )
        db.add(entry)
        db.flush()
        for bid, bdata in biomarkers.items():
            db.add(BiomarkerReading(
                entry_id=eid,
                biomarker_id=bid,
                value=bdata["value"],
                status=bdata["status"],
            ))
        for att in BLOOD_ATTACHMENTS.get(eid, []):
            db.add(Attachment(
                id=att["id"],
                entry_id=eid,
                name=att["name"],
                type=att["type"],
                size=att["size"],
            ))
    db.flush()


def _seed_doctor_visits(db) -> None:
    existing = {r.id for r in db.query(MedicalEntry.id).all()}
    for vd in DOCTOR_VISITS:
        eid = vd["id"]
        if eid in existing:
            continue
        entry = MedicalEntry(
            id=eid,
            patient_id=DEFAULT_PATIENT_ID,
            type="doctor_visit",
            date=datetime.fromisoformat(vd["date"]).replace(tzinfo=timezone.utc),
            title=vd["title"],
            subtitle=vd["subtitle"],
            category=vd["category"],
            status=vd.get("status", "Completed"),
            clinic=vd["clinic"],
        )
        db.add(entry)
        db.flush()
        for att in vd["attachments"]:
            db.add(Attachment(
                id=att["id"],
                entry_id=eid,
                name=att["name"],
                type=att["type"],
                size=att["size"],
            ))
        v = vd["visit_data"]
        db.add(VisitData(
            entry_id=eid,
            specialty=v["specialty"],
            provider=v["provider"],
            date=v["date"],
            clinic=v["clinic"],
            verdict=v["verdict"],
            notes=v["notes"],
            prescriptions=v["prescriptions"],
            recommendations=v["recommendations"],
        ))
    db.flush()


def _seed_procedures(db) -> None:
    existing = {r.id for r in db.query(MedicalEntry.id).all()}
    for proc in PROCEDURES:
        eid = proc["id"]
        if eid in existing:
            continue
        entry = MedicalEntry(
            id=eid,
            patient_id=DEFAULT_PATIENT_ID,
            type=proc["type"],
            date=datetime.fromisoformat(proc["date"]).replace(tzinfo=timezone.utc),
            title=proc["title"],
            subtitle=proc["subtitle"],
            category=proc["category"],
            status=proc.get("status", "Completed"),
            clinic=proc["clinic"],
        )
        db.add(entry)
        db.flush()
        for att in proc["attachments"]:
            db.add(Attachment(
                id=att["id"],
                entry_id=eid,
                name=att["name"],
                type=att["type"],
                size=att["size"],
            ))
    db.flush()


def seed_db(db) -> None:
    _seed_patient(db)
    _seed_biomarker_definitions(db)
    _seed_blood_tests(db)
    _seed_doctor_visits(db)
    _seed_procedures(db)
    db.commit()
