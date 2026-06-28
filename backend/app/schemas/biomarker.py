from pydantic import BaseModel
from typing import Optional


class Reading(BaseModel):
    date: str
    value: float
    status: str


class BiomarkerDefinition(BaseModel):
    id: str
    name_en: str
    name_ru: str
    category: str
    range_min: float
    range_max: float
    unit: str


class BiomarkerResult(BaseModel):
    id: str
    definition: BiomarkerDefinition
    value: float
    date: str
    status: str  # 'normal' | 'low' | 'high'
    history: list[Reading] = []


class MatrixCell(BaseModel):
    value: str
    status: str


class MatrixRow(BaseModel):
    id: str
    name: str
    original: str
    range: str
    cells: list[MatrixCell]


class MatrixCategory(BaseModel):
    category: str
    rows: list[MatrixRow]
