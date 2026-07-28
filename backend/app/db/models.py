from datetime import datetime, timezone

from sqlalchemy import Column, String, Float, Integer, JSON, DateTime, ForeignKey, Boolean, Boolean
from sqlalchemy.orm import relationship

from app.db.session import Base


class Patient(Base):
    __tablename__ = "patients"

    id = Column(String, primary_key=True)
    email = Column(String, nullable=False, unique=True, index=True)
    hashed_password = Column(String, nullable=False)
    name = Column(String, nullable=False)
    dob = Column(String, nullable=False)
    gender = Column(String, nullable=False)
    external_id = Column(String, nullable=False)

    entries = relationship("MedicalEntry", back_populates="patient", cascade="all, delete-orphan")


class BiomarkerDefinition(Base):
    __tablename__ = "biomarker_definitions"

    id = Column(String, primary_key=True)
    loinc_code = Column(String, nullable=True, index=True)
    names = Column(JSON, nullable=False)
    synonyms = Column(JSON, nullable=True)
    category = Column(String, nullable=False)
    # Single structured reference: {"kind":"interval","low":..,"high":..} or
    # {"kind":"qualitative","expected":..} ; null = no reference known. The
    # `kind` is the sole discriminator of the result type.
    reference = Column(JSON, nullable=True)
    unit = Column(String, nullable=False)
    scope = Column(String, nullable=False, default="global")
    user_id = Column(String, nullable=True)
    reference_source = Column(String, nullable=False, default="global")
    # LOINC COMMON_TEST_RANK: lower = more commonly ordered. Used to pick the
    # canonical definition when several share a name/synonym. Null for local.
    common_rank = Column(Integer, nullable=True)

    readings = relationship("BiomarkerReading", back_populates="definition")


class MedicalEntry(Base):
    __tablename__ = "medical_entries"

    id = Column(String, primary_key=True)
    patient_id = Column(String, ForeignKey("patients.id"), nullable=False)
    type = Column(String, nullable=False)
    date = Column(DateTime(timezone=True), nullable=False)
    title = Column(String, nullable=False)
    subtitle = Column(String, default="")
    category = Column(String, default="")
    status = Column(String, default="")
    clinic = Column(String, default="")
    notes = Column(String, default="")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    patient = relationship("Patient", back_populates="entries")
    biomarker_readings = relationship("BiomarkerReading", back_populates="entry", cascade="all, delete-orphan")
    attachments = relationship("Attachment", back_populates="entry", cascade="all, delete-orphan")
    visit_data = relationship("VisitData", back_populates="entry", uselist=False, cascade="all, delete-orphan")


class BiomarkerReading(Base):
    __tablename__ = "biomarker_readings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    entry_id = Column(String, ForeignKey("medical_entries.id"), nullable=False)
    biomarker_id = Column(String, ForeignKey("biomarker_definitions.id"), nullable=False)
    # Numeric results land in `value` (now nullable); qualitative results land
    # in `value_text`. On the wire the two are merged into a single union field
    # interpreted via the reference's `kind`.
    value = Column(Float, nullable=True)
    value_text = Column(String, nullable=True)
    # Effective structured reference snapshot at the time of the reading
    # (document's own if printed, else the definition's).
    reference = Column(JSON, nullable=True)
    status = Column(String, nullable=False)
    original_name = Column(String, nullable=True)
    original_value = Column(String, nullable=True)
    original_unit = Column(String, nullable=True)
    original_range = Column(String, nullable=True)

    entry = relationship("MedicalEntry", back_populates="biomarker_readings")
    definition = relationship("BiomarkerDefinition", back_populates="readings")


class Attachment(Base):
    __tablename__ = "attachments"

    id = Column(String, primary_key=True)
    entry_id = Column(String, ForeignKey("medical_entries.id"), nullable=False)
    name = Column(String, nullable=False)
    type = Column(String, nullable=False)
    size = Column(String, nullable=False)
    file_path = Column(String, nullable=True)

    entry = relationship("MedicalEntry", back_populates="attachments")


class VisitData(Base):
    __tablename__ = "visit_data"

    entry_id = Column(String, ForeignKey("medical_entries.id"), primary_key=True)
    specialty = Column(String, nullable=False)
    provider = Column(String, nullable=False)
    date = Column(DateTime(timezone=True), nullable=False)
    clinic = Column(String, nullable=False)
    verdict = Column(JSON, nullable=False)
    notes = Column(JSON, nullable=False)
    prescriptions = Column(JSON, nullable=False)
    recommendations = Column(JSON, nullable=False)

    entry = relationship("MedicalEntry", back_populates="visit_data")


class UsageLimit(Base):
    __tablename__ = "usage_limits"

    user_id = Column(String, primary_key=True)
    is_anonymous = Column(Boolean, default=True)

    ai_extraction_count = Column(Integer, default=0)
    total_upload_size_bytes = Column(Integer, default=0)
    last_activity = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
