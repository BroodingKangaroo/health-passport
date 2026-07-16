from app.db.models import (
    Patient,
    BiomarkerDefinition,
)
from app.auth import get_password_hash as hash_password
from app.mock_db import (
    BIOMARKER_DEFINITIONS,
)

DEFAULT_PATIENT_ID = "default"


def _seed_biomarker_definitions(db) -> None:
    existing = {r.id for r in db.query(BiomarkerDefinition.id).all()}
    existing_names = {
        (r.names or {}).get("en", "").strip().lower()
        for r in db.query(BiomarkerDefinition.names).all()
    }
    for bid, defn in BIOMARKER_DEFINITIONS.items():
        name_key = defn["names"]["en"].strip().lower()
        if bid not in existing and name_key not in existing_names:
            existing_names.add(name_key)
            db.add(BiomarkerDefinition(
                id=bid,
                loinc_code=defn.get("loinc_code"),
                names=defn["names"],
                synonyms=defn.get("synonyms"),
                category=defn["category"],
                range_min=defn["range_min"],
                range_max=defn["range_max"],
                unit=defn["unit"],
                scope=defn.get("scope", "global"),
                user_id=defn.get("user_id"),
            ))
    db.flush()


def seed_db(db) -> None:
    if not db.query(Patient).filter(Patient.id == DEFAULT_PATIENT_ID).first():
        db.add(Patient(
            id=DEFAULT_PATIENT_ID,
            email="alexey@example.com",
            hashed_password=hash_password("password123"),
            name="Alexey Ivanov",
            dob="1988-03-14",
            gender="Male",
            external_id="HP-2026-04417",
        ))
        db.flush()
    _seed_biomarker_definitions(db)
    db.commit()