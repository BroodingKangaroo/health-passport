from pydantic import BaseModel
from typing import Optional, Union

from app.schemas.reference import Reference


class Reading(BaseModel):
    date: str
    value: Union[float, str, None] = None
    status: str
    reference: Optional[Reference] = None
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
    reference: Optional[Reference] = None
    unit: str
    scope: str = "global"
    user_id: Optional[str] = None
    reference_source: str = "global"


class BiomarkerResult(BaseModel):
    id: str
    definition: BiomarkerDefinition
    value: Union[float, str, None] = None
    date: str
    status: str
    history: list[Reading] = []
    reference: Optional[Reference] = None
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
    reference: Optional[Reference] = None
    scope: str = "global"
    user_id: Optional[str] = None
    reference_source: str = "global"


class MatrixCell(BaseModel):
    value: str
    status: str


class MatrixRow(BaseModel):
    id: str
    name: str
    original: str
    unit: str
    reference: Optional[Reference] = None
    cells: list[MatrixCell]


class MatrixCategory(BaseModel):
    category: str
    rows: list[MatrixRow]