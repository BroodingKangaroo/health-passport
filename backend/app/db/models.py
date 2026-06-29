from datetime import datetime, timezone

from sqlalchemy import Column, String, Float, Integer, JSON, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from app.db.session import Base


class Patient(Base):
    __tablename__ = "patients"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    dob = Column(String, nullable=False)
    gender = Column(String, nullable=False)
    external_id = Column(String, nullable=False)

    entries = relationship("MedicalEntry", back_populates="patient", cascade="all, delete-orphan")


class BiomarkerDefinition(Base):
    __tablename__ = "biomarker_definitions"

    id = Column(String, primary_key=True)
    name_en = Column(String, nullable=False)
    name_ru = Column(String, nullable=False)
    category = Column(String, nullable=False)
    range_min = Column(Float, nullable=False)
    range_max = Column(Float, nullable=False)
    unit = Column(String, nullable=False)

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
    value = Column(Float, nullable=False)
    status = Column(String, nullable=False)

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
    date = Column(String, nullable=False)
    clinic = Column(String, nullable=False)
    verdict = Column(String, nullable=False)
    notes = Column(JSON, nullable=False)
    prescriptions = Column(JSON, nullable=False)
    recommendations = Column(JSON, nullable=False)

    entry = relationship("MedicalEntry", back_populates="visit_data")
