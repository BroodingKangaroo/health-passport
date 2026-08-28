from typing import Annotated, Optional, Union

from pydantic import BaseModel, Field
from typing_extensions import Literal

from app.schemas.reference import Reference

# Cap client-supplied strings so a single translation cannot bloat a
# definition's names JSON column or a cache row. Names/headings longer than
# this are rejected by validation rather than persisted.
NAME_MAX_LENGTH = 200
CATEGORY_MAX_LENGTH = 200
CATEGORY_MAX_ITEMS = 200

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


class RawInstrumentalData(BaseModel):
    modality: str = ""
    findings: str = ""
    conclusion: str = ""


class RawMedicalRecord(BaseModel):
    entry_type: Literal["blood_test", "doctor_visit", "instrumental_test", "unknown"]
    date: str = ""
    time: str = ""
    clinic: str = ""
    provider: str = ""
    title: str = ""
    notes: str = ""
    biomarkers: list[RawBiomarker] = []
    visit_data: RawVisitData = RawVisitData()
    instrumental_data: RawInstrumentalData = RawInstrumentalData()


# +++++ Zero-shot LOINC guess from LLM +++++

class LoincGuess(BaseModel):
    raw_name: str
    standard_name_en: str
    # Optional, NOT ""-defaulted str: the zero-shot prompt explicitly tells
    # the model "set guessed_loinc to null when no candidate fits" — a strict
    # schema-literal model (GLM, GPT-class) obeys and emits null, which a
    # plain str field rejects, killing the WHOLE batch parse. verify_or_create
    # already treats None as "no guess".
    guessed_loinc: Optional[str] = None


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


# +++++ Biomarker name translation (English -> de/fr/es/he/pl) +++++

class BiomarkerNameItem(BaseModel):
    id: str
    name: Annotated[str, Field(max_length=NAME_MAX_LENGTH)]


class TranslateRequest(BaseModel):
    lang: Literal["de", "fr", "es", "he", "pl"]
    names: list[BiomarkerNameItem] = []
    # Category/panel heading strings to translate alongside ``names``. Unlike
    # names these are never persisted — they come back in the response only
    # (keyed by the exact input string) for the current document render.
    categories: list[Annotated[str, Field(max_length=CATEGORY_MAX_LENGTH)]] = Field(
        default=[], max_items=CATEGORY_MAX_ITEMS
    )
    # When False (review flow), translations are returned but NOT persisted —
    # the client confirms them afterwards via /translate-biomarkers/commit.
    persist: bool = True


class CommitTranslationItem(BaseModel):
    id: str
    name: Annotated[str, Field(max_length=NAME_MAX_LENGTH)]


class CommitTranslationRequest(BaseModel):
    """Reviewed translations chosen by the user in the print-setup review
    dialog; written verbatim into the definitions' ``names[lang]``."""
    lang: Literal["de", "fr", "es", "he", "pl"]
    items: list[CommitTranslationItem] = []


class TranslationItem(BaseModel):
    id: str
    name: str
    # How ``name`` was produced: newly LLM-translated this request, already
    # persisted on the definition (no LLM call), or English fallback (LLM
    # failure, unresolvable/foreign id, or empty name).
    source: Literal["translated", "cached", "fallback"] = "fallback"


class CategoryTranslationItem(BaseModel):
    original: str
    translated: str
    # ``translated`` is newly LLM-translated this request, or the original
    # string as an English fallback (LLM failure or empty input). Categories
    # are never persisted, so there is no "cached" state.
    source: Literal["translated", "fallback"] = "fallback"


class TranslationBatch(BaseModel):
    translations: list[TranslationItem]


class TranslateResponse(BaseModel):
    translations: list[TranslationItem]
    categories: list[CategoryTranslationItem] = []


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
    # True when the canonical unit was LLM-invented (empty unit cell in source).
    canonical_unit_inferred: bool = False


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
    entry_type: Literal["blood_test", "doctor_visit", "instrumental_test", "unknown"]
    date: str = ""
    time: str = ""
    clinic: str = ""
    provider: str = ""
    title: str = ""
    notes: str = ""
    biomarkers: list[StandardizedBiomarker] = []
    visit_data: StandardizedVisitData = StandardizedVisitData()
    instrumental_data: RawInstrumentalData = RawInstrumentalData()