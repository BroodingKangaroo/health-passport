from pydantic import BaseModel
from typing import Optional, Union
from typing_extensions import Literal

from app.schemas.reference import Reference


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
    # Best-effort standard English name for the analyte, used to improve
    # matching of localized (non-English) documents. May be empty.
    standard_name_en: str = ""


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
    date: str = ""
    time: str = ""
    clinic: str = ""
    provider: str = ""
    title: str = ""
    notes: str = ""
    biomarkers: list[RawBiomarker] = []
    visit_data: RawVisitData = RawVisitData()
    imaging_data: RawImagingData = RawImagingData()


# +++++ Zero-shot LOINC guess from LLM +++++

class LoincGuess(BaseModel):
    raw_name: str
    standard_name_en: str
    guessed_loinc: str = ""


class LoincGuessBatch(BaseModel):
    guesses: list[LoincGuess]


# +++++ LLM verification of an existing match +++++

class MatchVerification(BaseModel):
    raw_name: str
    # True when the proposed match is the correct analyte for raw_name.
    agree: bool = True
    # When agree is False, the correct standard English analyte name (best guess).
    corrected_name_en: str = ""
    # Optional LOINC code the LLM believes is correct (validated before use).
    corrected_loinc: str = ""


class MatchVerificationBatch(BaseModel):
    verifications: list[MatchVerification]


# +++++ LLM-assisted unit conversion factor +++++

class ConversionFactor(BaseModel):
    # value_in_target = value_in_source * factor
    factor: Optional[float] = None
    # Set true only when the conversion is well-defined and safe to apply.
    convertible: bool = False


# +++++ LLM-assisted unit translation (raw -> English canonical) +++++

class UnitTranslation(BaseModel):
    # The standard English form of the unit (e.g. "copies/mL", "mg/dL",
    # "lg copies/mL"). Empty when the LLM couldn't decide.
    unit: str = ""
    # "linear" (default) or "log10". Used to pick 10^x vs log10(x) when
    # scaling across scales.
    kind: str = "linear"
    # True when the canonical unit was invented by the LLM (the source PDF
    # had no unit cell) rather than translated from an existing unit.
    inferred: bool = False


class UnitTranslationBatch(BaseModel):
    translations: list[UnitTranslation]


# +++++ LLM-assisted scale conversion (log10 <-> linear, units within scale) +++++

class ScaleFunction(BaseModel):
    # "10^x" / "log10" / "exp(x)" for non-linear cross-scale conversions,
    # or "factor:<float>" for a linear multiplicative conversion. Empty when
    # the LLM can't decide.
    function: str = ""


# +++++ Pass 2 — Standardized (normalized, matched, converted, translated) +++++

class StandardizedBiomarker(BaseModel):
    raw_name: str
    raw_value: str
    raw_unit: str
    raw_range_string: str = ""
    standard_name_en: str
    standard_value: Union[float, str, None] = None
    standard_unit: str
    reference: Optional[Reference] = None
    status: str = ""
    category: str = ""
    definition_id: str = ""
    scope: str = "global"
    # Scale conversion applied to land `standard_value` in the def's
    # canonical unit. "10^x" / "log10" / "factor:1.5" / null.
    scale_function: Optional[str] = None
    # True when the LLM couldn't determine a cross-scale conversion; the
    # reading is kept raw and the UI surfaces a warning.
    needs_review: bool = False


class StandardizedPrescription(BaseModel):
    name: TranslatedText
    dosage: TranslatedText
    instructions: TranslatedText


class StandardizedVisitData(BaseModel):
    diagnosis: TranslatedText = TranslatedText()
    chief_complaint: TranslatedText = TranslatedText()
    objective_findings: TranslatedText = TranslatedText()
    prescriptions: list[StandardizedPrescription] = []
    recommendations: list[TranslatedText] = []


class StandardizedMedicalRecord(BaseModel):
    entry_type: Literal["blood_test", "doctor_visit", "imaging", "unknown"]
    date: str = ""
    time: str = ""
    clinic: str = ""
    provider: str = ""
    title: str = ""
    notes: str = ""
    biomarkers: list[StandardizedBiomarker] = []
    visit_data: StandardizedVisitData = StandardizedVisitData()
    imaging_data: RawImagingData = RawImagingData()


# +++++ Legacy aliases for types shared across passes +++++

ExtractedPrescription = RawPrescription
ExtractedImagingData = RawImagingData