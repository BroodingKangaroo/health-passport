from pydantic import BaseModel
from typing import Optional


class Prescription(BaseModel):
    id: int
    name: str
    dose: str
    instruction: str


class VisitNote(BaseModel):
    heading: Optional[str] = None
    text: str


class Attachment(BaseModel):
    id: str
    name: str
    type: str
    size: str
    url: Optional[str] = None


class MedicalEvent(BaseModel):
    id: str
    type: str
    date: str
    title: str
    subtitle: str = ""
    category: str = ""
    status: str = ""
    clinic: str = ""
    attachments: list[Attachment] = []


class VisitData(BaseModel):
    specialty: str
    provider: str
    date: str
    clinic: str
    verdict: str
    notes: list[VisitNote]
    prescriptions: list[Prescription]
    recommendations: list[str]
    attachments: list[Attachment]
