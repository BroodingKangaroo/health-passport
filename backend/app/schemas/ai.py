from pydantic import BaseModel
from typing import Optional
from typing_extensions import Literal


# +++++ Reusable dual-language text container +++++

class TranslatedText(BaseModel):
    original: str = ""
    translated_en: str = ""


# +++++ Pass 1 — Raw extraction (preserve source text exactly as written) +++++

class RawBiomarker(BaseModel):
    name: str
    value: str
    unit: str
    raw_range_string: str = ""
    category: str = ""


class RawPrescription(BaseModel):
    name: str
    dosage: str = ""
    instructions: str = ""


class RawVisitData(BaseModel):
    diagnosis: str = ""
    chief_complaint: str = ""
    objective_findings: str = ""
    prescriptions: list[RawPrescription] = []
    recommendations: list[str] = []


class RawImagingData(BaseModel):
    modality: str = ""
    findings: str = ""
    conclusion: str = ""


class RawMedicalRecord(BaseModel):
    entry_type: Literal["blood_test", "doctor_visit", "imaging", "unknown"]
    date: Optional[str] = None
    time: Optional[str] = None
    clinic: Optional[str] = None
    provider: Optional[str] = None
    title: Optional[str] = None
    notes: Optional[str] = None
    biomarkers: Optional[list[RawBiomarker]] = None
    visit_data: Optional[RawVisitData] = None
    imaging_data: Optional[RawImagingData] = None


# +++++ Pass 2 — Standardized (normalized, matched, converted, translated) +++++

class StandardizedBiomarker(BaseModel):
    raw_name: str
    raw_value: str
    raw_unit: str
    raw_range_string: str = ""
    standard_name_en: str
    standard_value: float
    standard_unit: str
    standard_range_min: Optional[float] = None
    standard_range_max: Optional[float] = None
    status: str = ""
    category: str = ""


class StandardizedPrescription(BaseModel):
    name: TranslatedText
    dosage: TranslatedText
    instructions: TranslatedText


class StandardizedVisitData(BaseModel):
    diagnosis: TranslatedText
    chief_complaint: TranslatedText
    objective_findings: TranslatedText
    prescriptions: list[StandardizedPrescription] = []
    recommendations: list[TranslatedText] = []


class StandardizedMedicalRecord(BaseModel):
    entry_type: Literal["blood_test", "doctor_visit", "imaging", "unknown"]
    date: Optional[str] = None
    time: Optional[str] = None
    clinic: Optional[str] = None
    provider: Optional[str] = None
    title: Optional[str] = None
    notes: Optional[str] = None
    biomarkers: Optional[list[StandardizedBiomarker]] = None
    visit_data: Optional[StandardizedVisitData] = None
    imaging_data: Optional[RawImagingData] = None


# +++++ Legacy aliases for types shared across passes +++++

ExtractedPrescription = RawPrescription
ExtractedImagingData = RawImagingData
