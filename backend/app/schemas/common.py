from typing import Optional

from pydantic import BaseModel

from .biomarker import BiomarkerResult, MatrixCategory
from .medical_event import MedicalEvent, VisitData


class DateHeader(BaseModel):
    label: str
    sub: Optional[str] = None


class TimelineResponse(BaseModel):
    events: list[MedicalEvent]
    biomarkers: list[BiomarkerResult]
    visits: dict[str, VisitData] = {}


class FlowsheetResponse(BaseModel):
    dates: list[DateHeader]
    matrix: list[MatrixCategory]
    biomarkers: list[BiomarkerResult]


class SaveEntryResponse(BaseModel):
    success: bool
    message: str
    id: str = ""


class DeleteEntryResponse(BaseModel):
    success: bool
    id: str
    deleted_visit_data: bool = False
    freed_bytes: int = 0


class EntryBiomarkerRef(BaseModel):
    """The definitions a reading references, so callers can detect biomarker
    overlap (e.g. when deciding whether two blood tests can merge)."""
    definition_id: str
    loinc_code: Optional[str] = None
    names: dict[str, str] = {}
    synonyms: list[str] = []


class EntrySummary(BaseModel):
    id: str
    title: str
    date: str
    # "HH:MM" when the entry has a time, else null.
    time: Optional[str] = None
    biomarkers: list[EntryBiomarkerRef] = []


class EntriesByDateResponse(BaseModel):
    date: str
    count: int
    entries: list[EntrySummary] = []


class UsageLimitsResponse(BaseModel):
    is_anonymous: bool
    ai_extraction_count: int
    ai_extraction_limit: int
    total_upload_size_bytes: int
    total_upload_limit_bytes: int
