from typing import Optional, Union

from pydantic import BaseModel

from app.schemas.reference import Reference


class MergedSource(BaseModel):
    """Metadata of the second (merged-in) upload: what the user typed for the
    test that contributed these readings (name/title, doctor, place, time).
    Only present on readings created by POST /api/entry/{id}/merge."""
    title: Optional[str] = None
    clinic: Optional[str] = None
    provider: Optional[str] = None
    time: Optional[str] = None


class Reading(BaseModel):
    # The medical entry (blood test) the reading belongs to. Lets clients match
    # readings to events unambiguously when several tests share a date.
    entry_id: str
    date: str
    value: Union[float, str, None] = None
    status: str
    reference: Optional[Reference] = None
    original_name: Optional[str] = None
    original_value: Optional[str] = None
    original_unit: Optional[str] = None
    original_range: Optional[str] = None
    # Scale conversion applied: "10^x" / "log10" / "factor:1.5" / null.
    scale_function: Optional[str] = None
    # True when the LLM couldn't determine a cross-scale conversion.
    needs_review: bool = False
    # True when the reading was merged into an existing entry from a later
    # upload rather than created with it.
    merged: bool = False
    # Source upload metadata for merged readings (see MergedSource).
    merged_source: Optional[MergedSource] = None


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
    # Canonical (English) unit + scale kind for cross-document comparison.
    canonical_unit: Optional[str] = None
    canonical_kind: Optional[str] = None
    canonical_unit_inferred: bool = False


class BiomarkerResult(BaseModel):
    id: str
    # Entry the top-level (latest) reading belongs to; history readings carry
    # their own entry_id.
    entry_id: str
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
    # True when the latest reading was merged into an existing entry.
    merged: bool = False
    # Source upload metadata for the latest reading when it was merged in.
    merged_source: Optional[MergedSource] = None


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
    canonical_unit: Optional[str] = None
    canonical_kind: Optional[str] = None
    canonical_unit_inferred: bool = False


class MatrixCell(BaseModel):
    value: str
    status: str
    # "10^x" / "log10" / "factor:1.5" / null. The flowsheet surfaces this so the
    # UI can show the original in a footnote next to the converted value.
    scale_function: Optional[str] = None
    # True when the LLM couldn't determine a cross-scale conversion. The
    # flowsheet cell still renders the raw value; the UI shows a warning.
    needs_review: bool = False
    # True when the reading was merged into an existing entry from a later
    # upload rather than created with it.
    merged: bool = False


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