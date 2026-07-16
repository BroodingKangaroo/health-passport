"""
Service for migrating anonymous user data to registered accounts.
"""

import uuid
from sqlalchemy.orm import Session
from app.db.models import (
    MedicalEntry,
    BiomarkerDefinition,
    Attachment,
    VisitData,
    BiomarkerReading,
    UsageLimit,
)


def has_anonymous_data(db: Session, anon_id: str) -> bool:
    """Check if anonymous user has any data."""
    # Check for entries
    entry_count = db.query(MedicalEntry).filter(
        MedicalEntry.patient_id == anon_id
    ).count()

    if entry_count > 0:
        return True

    # Check for custom biomarker definitions
    def_count = db.query(BiomarkerDefinition).filter(
        BiomarkerDefinition.user_id == anon_id,
        BiomarkerDefinition.scope == "local"
    ).count()

    return def_count > 0


def copy_anonymous_data(db: Session, anon_id: str, new_user_id: str) -> dict:
    """
    Copy all anonymous user data to new registered user.
    Generates new IDs for entries so anonymous data remains intact.
    Returns a summary of what was copied.
    """
    summary = {
        "entries_copied": 0,
        "biomarker_defs_copied": 0,
        "attachments_copied": 0,
        "visit_data_copied": 0,
        "readings_copied": 0,
    }

    # Copy medical entries (generate new IDs to avoid conflicts)
    entries = db.query(MedicalEntry).filter(
        MedicalEntry.patient_id == anon_id
    ).all()

    # Map old entry IDs to new entry IDs
    entry_id_map: dict[str, str] = {}
    for entry in entries:
        new_entry_id = uuid.uuid4().hex[:8]
        entry_id_map[entry.id] = new_entry_id

        new_entry = MedicalEntry(
            id=new_entry_id,
            patient_id=new_user_id,
            type=entry.type,
            date=entry.date,
            title=entry.title,
            subtitle=entry.subtitle,
            category=entry.category,
            status=entry.status,
            clinic=entry.clinic,
            notes=entry.notes,
            created_at=entry.created_at,
        )
        db.add(new_entry)
        summary["entries_copied"] += 1

    # Copy biomarker definitions (only local ones, generate new IDs)
    defs = db.query(BiomarkerDefinition).filter(
        BiomarkerDefinition.user_id == anon_id,
        BiomarkerDefinition.scope == "local"
    ).all()

    # Map old def IDs to new def IDs
    def_id_map: dict[str, str] = {}
    for defn in defs:
        new_def_id = f"local-{uuid.uuid4().hex[:12]}"
        def_id_map[defn.id] = new_def_id

        new_def = BiomarkerDefinition(
            id=new_def_id,
            loinc_code=defn.loinc_code,
            names=defn.names,
            synonyms=defn.synonyms,
            category=defn.category,
            range_min=defn.range_min,
            range_max=defn.range_max,
            unit=defn.unit,
            scope="local",
            user_id=new_user_id,
            range_source=defn.range_source,
        )
        db.add(new_def)
        summary["biomarker_defs_copied"] += 1

    # Copy attachments (with new entry IDs)
    attachments = db.query(Attachment).filter(
        Attachment.entry_id.in_([e.id for e in entries])
    ).all()

    for att in attachments:
        new_entry_id = entry_id_map.get(att.entry_id, att.entry_id)
        new_att = Attachment(
            id=f"att-{uuid.uuid4().hex[:8]}",
            entry_id=new_entry_id,
            name=att.name,
            type=att.type,
            size=att.size,
            file_path=att.file_path,
        )
        db.add(new_att)
        summary["attachments_copied"] += 1

    # Copy visit data (with new entry IDs)
    visit_data_list = db.query(VisitData).filter(
        VisitData.entry_id.in_([e.id for e in entries])
    ).all()

    for vd in visit_data_list:
        new_entry_id = entry_id_map.get(vd.entry_id, vd.entry_id)
        new_vd = VisitData(
            entry_id=new_entry_id,
            specialty=vd.specialty,
            provider=vd.provider,
            date=vd.date,
            clinic=vd.clinic,
            verdict=vd.verdict,
            notes=vd.notes,
            prescriptions=vd.prescriptions,
            recommendations=vd.recommendations,
        )
        db.add(new_vd)
        summary["visit_data_copied"] += 1

    # Copy biomarker readings (with new entry IDs and new def IDs)
    readings = db.query(BiomarkerReading).filter(
        BiomarkerReading.entry_id.in_([e.id for e in entries])
    ).all()

    for reading in readings:
        new_entry_id = entry_id_map.get(reading.entry_id, reading.entry_id)
        # Use new def ID if it was a local def, otherwise keep global def ID
        new_biomarker_id = def_id_map.get(reading.biomarker_id, reading.biomarker_id)

        new_reading = BiomarkerReading(
            entry_id=new_entry_id,
            biomarker_id=new_biomarker_id,
            value=reading.value,
            status=reading.status,
            original_name=reading.original_name,
            original_value=reading.original_value,
            original_unit=reading.original_unit,
            original_range=reading.original_range,
        )
        db.add(new_reading)
        summary["readings_copied"] += 1

    db.commit()
    return summary
