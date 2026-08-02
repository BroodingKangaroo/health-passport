from typing import Optional

from pydantic import BaseModel

from .ai import TranslatedText


class Prescription(BaseModel):
    id: int
    name: TranslatedText
    dose: TranslatedText
    instruction: TranslatedText


class VisitNote(BaseModel):
    heading: Optional[str] = None
    text_translated: str = ""
    text_original: str = ""


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
    verdict: TranslatedText
    notes: list[VisitNote]
    prescriptions: list[Prescription]
    recommendations: list[TranslatedText]
    attachments: list[Attachment]
