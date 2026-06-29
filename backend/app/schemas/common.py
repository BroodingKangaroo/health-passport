from pydantic import BaseModel
from typing import Optional

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


class SaveEntryRequest(BaseModel):
    type: str
    data: dict


class SaveEntryResponse(BaseModel):
    success: bool
    message: str
    id: str = ""


class ApiError(BaseModel):
    detail: str
