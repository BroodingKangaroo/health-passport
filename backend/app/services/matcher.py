import json
import logging
from datetime import datetime
from typing import List, Optional

from mistralai import Mistral

from app.schemas.ai import (
    RawMedicalRecord,
    StandardizedMedicalRecord,
    StandardizedBiomarker,
)
from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel

logger = logging.getLogger(__name__)

NORMALIZE_PROMPT = """You are a medical data standardization assistant. Given raw biomarker data extracted from a medical document, perform the following tasks:

1. **Date/Time Normalization**: Parse the raw date string into ISO format (YYYY-MM-DD). Ensure time is present and formatted as HH:mm. If the raw date string contains a time (e.g., "2026-10-15T09:00"), extract and populate the time field separately. If the date is ambiguous, use your best judgment based on context.

2. **Name Matching**: For each biomarker, match the raw name to the closest standard English name from the provided list. If a close match exists, use the standard name. If no close match exists, use the raw name as the standard name.

3. **Range Parsing**: Parse the raw_range_string into numeric standard_range_min and standard_range_max:
   - "1.32 - 3.57" → standard_range_min=1.32, standard_range_max=3.57
   - "< 5.0" or "< 5" → standard_range_min=null, standard_range_max=5.0
   - "> 100" → standard_range_min=100, standard_range_max=null
   - "Absent", "Negative", or "Not detected" → standard_range_min=0, standard_range_max=0
   - Leave both null if the string cannot be parsed into numeric bounds.

4. **Unit Conversion** (the only math the LLM should perform): If the raw_unit differs from the matched definition's standard unit, mathematically convert:
   - raw_value → standard_value
   - raw_range bounds → standard_range_min / standard_range_max
   For unmatched biomarkers, pass all values through unchanged.

5. **Category Assignment**: If matched to a known definition, use that definition's category. For unmatched ones, use the raw category or "General".

For each biomarker always provide:
- raw_name, raw_value, raw_unit, raw_range_string (provenance from source document)
- standard_name_en, standard_value, standard_unit
- standard_range_min, standard_range_max
- category

Do NOT provide a status field. Status is computed server-side after this step.
Preserve the clinic, provider, title, notes, visit_data, and imaging_data fields from the raw record exactly as provided.

Return ONLY valid JSON matching the provided schema. Do not include any text outside the JSON."""


def calculate_biomarker_status(value: float, min_val: Optional[float], max_val: Optional[float]) -> str:
    if min_val is not None and value < min_val:
        return "low"
    if max_val is not None and value > max_val:
        return "high"
    return "normal"


def _normalize_date(raw_date: str) -> str:
    if not raw_date:
        return datetime.now().strftime("%Y-%m-%d")
    try:
        dt = datetime.fromisoformat(raw_date)
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        pass
    return raw_date


def _normalize_time(raw_time: str) -> str:
    if not raw_time:
        return ""
    try:
        dt = datetime.fromisoformat(raw_time)
        return dt.strftime("%H:%M")
    except (ValueError, TypeError):
        pass
    return raw_time


def _fill_ranges(result: StandardizedMedicalRecord, definitions: list) -> None:
    def_map = {d.name_en.lower(): d for d in definitions}
    if not result.biomarkers:
        return
    for b in result.biomarkers:
        if b.standard_range_min is None and b.standard_range_max is None:
            match = def_map.get(b.standard_name_en.lower())
            if match and match.range_min is not None:
                b.standard_range_min = match.range_min
                b.standard_range_max = match.range_max


def _apply_status(result: StandardizedMedicalRecord) -> None:
    if not result.biomarkers:
        return
    for b in result.biomarkers:
        b.status = calculate_biomarker_status(
            b.standard_value, b.standard_range_min, b.standard_range_max
        )


def _fallback_standardize(raw: RawMedicalRecord) -> StandardizedMedicalRecord:
    biomarkers: list[StandardizedBiomarker] = []
    if raw.biomarkers:
        for b in raw.biomarkers:
            try:
                std_value = float(b.value)
            except (ValueError, TypeError):
                std_value = 0.0

            biomarkers.append(StandardizedBiomarker(
                raw_name=b.name,
                raw_value=b.value,
                raw_unit=b.unit,
                raw_range_string=b.raw_range_string,
                standard_name_en=b.name,
                standard_value=std_value,
                standard_unit=b.unit,
                standard_range_min=None,
                standard_range_max=None,
                status="",
                category=b.category or "General",
            ))

    return StandardizedMedicalRecord(
        entry_type=raw.entry_type,
        date=_normalize_date(raw.date or ""),
        time=_normalize_time(raw.time or ""),
        clinic=raw.clinic,
        provider=raw.provider,
        title=raw.title,
        notes=raw.notes,
        biomarkers=biomarkers or None,
        visit_data=raw.visit_data,
        imaging_data=raw.imaging_data,
    )


def match_and_convert(
    raw: RawMedicalRecord,
    definitions: List[BiomarkerDefinitionModel],
    client: Mistral,
) -> StandardizedMedicalRecord:
    known_list = "\n".join(
        f'  - "{d.name_en}" (category: {d.category}, unit: {d.unit}, range: {d.range_min}-{d.range_max})'
        for d in definitions
    )

    biomarker_json = []
    if raw.biomarkers:
        for b in raw.biomarkers:
            biomarker_json.append(b.model_dump())

    system_prompt = (
        NORMALIZE_PROMPT
        + f"\n\nKnown biomarker definitions:\n{known_list}"
        + "\n\nWhen matching, use the standard name from the list above when a close match exists. "
        "Set standard_name_en = raw_name for non-matching biomarkers. "
        "Only convert units when the biomarker is matched AND the unit differs."
    )

    payload = {
        "date": raw.date,
        "time": raw.time,
        "entry_type": raw.entry_type,
        "clinic": raw.clinic,
        "provider": raw.provider,
        "title": raw.title,
        "notes": raw.notes,
        "biomarkers": biomarker_json,
        "visit_data": raw.visit_data.model_dump() if raw.visit_data else None,
        "imaging_data": raw.imaging_data.model_dump() if raw.imaging_data else None,
    }

    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": str(payload)},
            ],
            response_format=StandardizedMedicalRecord,
            max_tokens=16000,
        )
    except Exception as e:
        logger.error("Matcher chat.parse failed: %s", e)
        result = _fallback_standardize(raw)
        _fill_ranges(result, definitions)
        _apply_status(result)
        return result

    content = chat_response.choices[0].message.content

    if isinstance(content, str):
        try:
            parsed = json.loads(content)
            result = StandardizedMedicalRecord(**parsed)
        except (json.JSONDecodeError, Exception) as e:
            logger.error("Failed to parse matcher response as JSON: %s", e)
            result = _fallback_standardize(raw)
    else:
        result = content

    _fill_ranges(result, definitions)
    _apply_status(result)
    return result
