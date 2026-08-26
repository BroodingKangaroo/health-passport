"""Shared mapping of ORM rows to Pydantic response schemas.

The timeline, flowsheet, and entries routers all flatten the same core shapes
(BiomarkerDefinition / Reading / BiomarkerResult) from the same ORM models.
Hoisting those builders here keeps the wire format consistent across endpoints
and removes the previous copy-pasted 18-field construction blocks.
"""

import re
from typing import Optional

from sqlalchemy.orm import Session

from app.api._format import effective_reference, reading_value
from app.db.models import (
    BiomarkerDefinition as BiomarkerDefinitionModel,
)
from app.schemas.biomarker import (
    BiomarkerDefinition as BiomarkerDefinitionSchema,
)
from app.schemas.biomarker import (
    BiomarkerResult,
    MergedSource,
    Reading,
)

_LOINC_RE = re.compile(r"^\d+-\d+(\.\d+)?$")


def is_loinc(code: Optional[str]) -> bool:
    return bool(code) and bool(_LOINC_RE.match(code))


def definition_schema(defn: BiomarkerDefinitionModel) -> BiomarkerDefinitionSchema:
    """Map a BiomarkerDefinition ORM row to its response schema. The visible
    unit always prefers the cross-document canonical unit when one is set."""
    return BiomarkerDefinitionSchema(
        id=defn.id,
        loinc_code=defn.loinc_code,
        names=defn.names,
        synonyms=defn.synonyms or [],
        category=defn.category,
        reference=defn.reference,
        unit=defn.canonical_unit or defn.unit,
        scope=defn.scope,
        reference_source=defn.reference_source,
        canonical_unit=defn.canonical_unit,
        canonical_kind=defn.canonical_kind,
        canonical_unit_inferred=bool(defn.canonical_unit_inferred),
    )


def reading_merged_source(reading) -> Optional[MergedSource]:
    """Build the MergedSource snapshot from a reading's stored merged_source
    JSON dict (None for original readings)."""
    src = reading.merged_source
    if not src or not isinstance(src, dict):
        return None
    return MergedSource(
        title=src.get("title") or None,
        clinic=src.get("clinic") or None,
        provider=src.get("provider") or None,
        time=src.get("time") or None,
    )


def reading_schema(
    reading,
    defn: BiomarkerDefinitionModel,
    date_label: str,
) -> Reading:
    """Map a single BiomarkerReading to its Reading schema, using the
    definition for the effective reference when the reading has none."""
    return Reading(
        entry_id=reading.entry_id,
        date=date_label,
        value=reading_value(reading),
        status=reading.status,
        reference=effective_reference(reading, defn),
        original_name=reading.original_name or "",
        original_value=reading.original_value or "",
        original_unit=reading.original_unit or "",
        original_range=reading.original_range or "",
        scale_function=reading.scale_function,
        needs_review=bool(reading.needs_review),
        merged=bool(reading.merged),
        merged_source=reading_merged_source(reading),
    )


def result_schema(
    id: str,
    defn: BiomarkerDefinitionModel,
    reading,
    date_label: str,
    entry_id: str,
    history: Optional[list[Reading]] = None,
    merged: bool = False,
    merged_source: Optional[MergedSource] = None,
) -> BiomarkerResult:
    """Map a definition plus its latest reading to the BiomarkerResult exposed
    on the timeline / flowsheet / detail endpoints. Timeline passes the actual
    merged/merged_source of the latest reading; flowsheet keeps the defaults."""
    return BiomarkerResult(
        id=id,
        entry_id=entry_id,
        definition=definition_schema(defn),
        value=reading_value(reading),
        date=date_label,
        status=reading.status,
        history=history or [],
        reference=effective_reference(reading, defn),
        original_name=reading.original_name or "",
        original_value=reading.original_value or "",
        original_unit=reading.original_unit or "",
        original_range=reading.original_range or "",
        merged=merged,
        merged_source=merged_source,
    )


def resolve_definitions(
    db: Session, ids: set[str]
) -> tuple[dict[str, BiomarkerDefinitionModel], dict[str, BiomarkerDefinitionModel]]:
    """Fetch the definitions referenced by a set of reading ids (which may
    themselves be LOINC codes from legacy ingestion). Returns both an id-keyed
    and a LOINC-keyed lookup."""
    if not ids:
        return {}, {}
    defns = (
        db.query(BiomarkerDefinitionModel)
        .filter(
            (BiomarkerDefinitionModel.id.in_(ids))
            | (BiomarkerDefinitionModel.loinc_code.in_(ids))
        )
        .all()
    )
    by_id = {d.id: d for d in defns}
    by_loinc = {d.loinc_code: d for d in defns if d.loinc_code}
    return by_id, by_loinc


def lookup_definition(
    by_id: dict[str, BiomarkerDefinitionModel],
    by_loinc: dict[str, BiomarkerDefinitionModel],
    biomarker_id: str,
) -> Optional[BiomarkerDefinitionModel]:
    return by_id.get(biomarker_id) or by_loinc.get(biomarker_id)