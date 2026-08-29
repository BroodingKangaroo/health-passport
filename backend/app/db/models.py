from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, Column, DateTime, Float, ForeignKey, Integer, String
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
    # Canonical unit (always English) for cross-document comparison. Set on
    # the first reading that creates the def; subsequent readings with a
    # different unit are converted to this one. NULL on legacy defs.
    canonical_unit = Column(String, nullable=True)
    # "linear" (default) or "log10" — tells the matcher whether the canonical
    # unit is in raw or log10-of-the-raw form. Used to pick 10^x vs log10(x)
    # when scaling a value across scales.
    canonical_kind = Column(String, nullable=True)
    # True when the canonical unit was LLM-invented (the source PDF had no unit
    # cell and the matcher asked the LLM to pick a sensible one based on the
    # analyte / category). Surfaced in the UI so the user can verify it
    # matches their lab's convention.
    canonical_unit_inferred = Column(Boolean, nullable=False, default=False)

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
    # Detected language of the source document (ISO 639-1 style code from the
    # fixed allowlist in app/services/language_detect.py), or None for legacy
    # rows, manual entries, and documents too short/ambiguous to classify.
    # Used by the print/export UI to label the "original" column.
    source_language = Column(String, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    patient = relationship("Patient", back_populates="entries")
    biomarker_readings = relationship("BiomarkerReading", back_populates="entry", cascade="all, delete-orphan")
    attachments = relationship("Attachment", back_populates="entry", cascade="all, delete-orphan")
    visit_data = relationship("VisitData", back_populates="entry", uselist=False, cascade="all, delete-orphan")
    instrumental_data = relationship("InstrumentalData", back_populates="entry", uselist=False, cascade="all, delete-orphan")


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
    # Scale conversion applied to land `value` in the definition's
    # canonical unit. NULL = no conversion (the reading was already in the
    # canonical scale). Examples: "10^x" (log→linear), "log10" (linear→log),
    # "factor:1.5" (linear unit conversion).
    scale_function = Column(String, nullable=True)
    # True when the LLM couldn't determine a cross-scale conversion. The
    # reading is kept raw (not converted) and the UI surfaces a warning.
    needs_review = Column(Boolean, nullable=False, default=False)
    # True when the reading was merged into an existing entry from a later
    # upload (POST /api/entry/{id}/merge) rather than created with it.
    # Lets the UI distinguish original readings from merged-in ones.
    merged = Column(Boolean, nullable=False, default=False)
    # Snapshot of the second (merged-in) upload's own metadata — what the user
    # typed for that upload: {title, clinic, provider, time}. Set on merged
    # readings only, so the UI can describe the source test that added them.
    merged_source = Column(JSON, nullable=True)

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


class InstrumentalData(Base):
    __tablename__ = "instrumental_data"

    entry_id = Column(String, ForeignKey("medical_entries.id"), primary_key=True)
    modality = Column(String, nullable=False, default="")
    findings = Column(String, nullable=False, default="")
    conclusion = Column(String, nullable=False, default="")

    entry = relationship("MedicalEntry", back_populates="instrumental_data")


class CategoryTranslationCache(Base):
    __tablename__ = "category_translation_cache"

    # Shared (all-users) cache for category/panel heading translations.
    # Headings are generic lab terms with no PII, so translations are keyed by
    # the language + cleaned heading string and never invalidated (temperature
    # 0 translations of static terminology don't go stale).
    # "{lang}:{sha256(cleaned_heading)}"
    id = Column(String, primary_key=True)
    original = Column(String, nullable=False)
    translated = Column(String, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id = Column(String, primary_key=True)
    patient_id = Column(String, ForeignKey("patients.id"), nullable=False)
    # SHA-256 of the raw token (the raw value is only ever emailed/returned
    # once); a DB leak must not allow replaying a reset.
    token_hash = Column(String, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    patient = relationship("Patient")


class UsageLimit(Base):
    __tablename__ = "usage_limits"

    user_id = Column(String, primary_key=True)
    is_anonymous = Column(Boolean, default=True)

    ai_extraction_count = Column(Integer, default=0)
    total_upload_size_bytes = Column(Integer, default=0)
    last_activity = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
