from pydantic import BaseModel
from typing import Optional


class Reading(BaseModel):
    date: str
    value: float
    status: str
    original_name: Optional[str] = None
    original_value: Optional[str] = None
    original_unit: Optional[str] = None
    original_range: Optional[str] = None


class BiomarkerDefinition(BaseModel):
    id: str
    loinc_code: Optional[str] = None
    names: dict[str, str]
    synonyms: list[str] = []
    category: str
    range_min: Optional[float] = None
    range_max: Optional[float] = None
    unit: str
    scope: str = "global"
    user_id: Optional[str] = None
    range_source: str = "global"


class BiomarkerResult(BaseModel):
    id: str
    definition: BiomarkerDefinition
    value: float
    date: str
    status: str
    history: list[Reading] = []
    range: str = ""
    original_name: Optional[str] = None
    original_value: Optional[str] = None
    original_unit: Optional[str] = None
    original_range: Optional[str] = None


class BiomarkerDefinitionResponse(BaseModel):
    id: str
    loinc_code: Optional[str] = None
    names: dict[str, str]
    synonyms: list[str] = []
    category: str
    unit: str
    range_min: Optional[float] = None
    range_max: Optional[float] = None
    scope: str = "global"
    user_id: Optional[str] = None
    range_source: str = "global"


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
