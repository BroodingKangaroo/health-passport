"""LLM translation of biomarker names and visit data (with fallbacks)."""

import json
import logging
from datetime import datetime

from mistralai import Mistral

from app.schemas.ai import (
    LoincGuessBatch,
    RawBiomarker,
    RawVisitData,
    StandardizedPrescription,
    StandardizedVisitData,
    TranslatedText,
)
from app.services.matcher._text import _is_ascii
from config import LLM_CALL_TIMEOUT_MS, MISTRAL_CHAT_MODEL

logger = logging.getLogger(__name__)

TRANSLATE_PROMPT = """You are a professional medical translator. Given the following clinical data from a doctor visit, transform every free-text clinical field into a dual-language object with both the original text and an English translation:

- `diagnosis`: TranslatedText with original source text and English translation
- `chief_complaint`: TranslatedText with original and translation
- `objective_findings`: TranslatedText with original and translation
- `prescriptions[*].name`: TranslatedText — keep international generic name if identifiable, translate localized brand names to English; always preserve the original
- `prescriptions[*].dosage`: TranslatedText — convert localized units to standard English (e.g., "мг" → "mg", "табл." → "tab"), preserve original
- `prescriptions[*].instructions`: TranslatedText — full medical translation of dosage instructions
- `recommendations[*]`: TranslatedText with original and translation

Translation rules:
- Provide highly accurate English medical translation using proper medical terminology
- Preserve all clinical nuance, qualifiers, severity descriptors, and numerical values
- Recommendations: keep the EXACT same number of list items — never merge or split them; translate each item independently and in full (never truncate)
- For medication names: keep the international generic name if identifiable in English; if only a localized brand name exists, transliterate and annotate
- For dosage units: convert localized abbreviations to standard English medical abbreviations
- ALWAYS carry over the original text untouched into the "original" field
- If the text is already in English, set both original and translated_en to the same value

Return ONLY valid JSON matching the provided schema. Do not include any text outside the JSON."""


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


def _tx(text: str) -> TranslatedText:
    return TranslatedText(original=text, translated_en=text)


_TRANSLATE_PROMPT = """You are a medical terminology translator. For each biomarker name extracted from a medical document, provide the standard English analyte name (e.g. "Билирубин общий" -> "Total bilirubin", "Bilirrubina total" -> "Total bilirubin").

Items:
{items}

Return a JSON array of objects, one per input in the same order, each with:
- raw_name: the original name (copy verbatim)
- standard_name_en: the standard English analyte name, or the original if it is already English"""


def _translate_names_batch(
    biomarkers: list[RawBiomarker],
    client: Mistral,
) -> dict[str, str]:
    """Translate non-English biomarker names to English via a single LLM call.

    Returns a mapping raw_name -> standard English analyte name for the names
    that were translated. A biomarker is skipped only when it already carries
    an ASCII ``standard_name_en``; Latin-script non-English names (e.g.
    Spanish "Bilirrubina total") have an empty effective English name and
    MUST be included — ASCII alone does not mean English (ISSUES.md #50).
    """
    need: list[RawBiomarker] = []
    for b in biomarkers:
        en = (b.standard_name_en or "").strip()
        if en and _is_ascii(en):
            continue
        if b.name:
            need.append(b)
    if not need or client is None:
        return {}

    item_lines = "\n".join(f'- "{b.name}"' for b in need)
    system_prompt = _TRANSLATE_PROMPT.format(items=item_lines)
    try:
        chat_response = client.chat.parse(
            timeout_ms=LLM_CALL_TIMEOUT_MS,
            model=MISTRAL_CHAT_MODEL,
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Return the JSON array now."},
            ],
            response_format=LoincGuessBatch,
            max_tokens=2000,
        )
    except Exception as e:
        logger.error("Name translation LLM call failed: %s", e)
        return {}

    content = chat_response.choices[0].message.content
    try:
        parsed = LoincGuessBatch(**json.loads(content)) if isinstance(content, str) else content
    except (json.JSONDecodeError, Exception) as e:
        logger.error("Failed to parse translation response: %s", e)
        return {}

    result: dict[str, str] = {}
    existing = {b.name: b for b in need}
    for g in parsed.guesses:
        src = existing.get(g.raw_name)
        if src is None:
            continue
        en = (g.standard_name_en or "").strip()
        if en and _is_ascii(en):
            # Persist back onto the RawBiomarker so downstream code uses it.
            src.standard_name_en = en
            result[g.raw_name] = en
    return result


def _llm_translate_visit_data(
    raw_visit_data: RawVisitData,
    client: Mistral,
) -> StandardizedVisitData:
    if not isinstance(raw_visit_data, RawVisitData):
        return StandardizedVisitData(
            diagnosis=_tx(str(raw_visit_data.diagnosis if hasattr(raw_visit_data, 'diagnosis') else raw_visit_data)),
            chief_complaint=TranslatedText(),
            objective_findings=TranslatedText(),
            prescriptions=[],
            recommendations=[],
        )

    # Compact JSON instead of the Python repr(str(payload)): same data, fewer
    # tokens, no single-quote noise for the model to parse around.
    payload = json.dumps(raw_visit_data.model_dump(), ensure_ascii=False,
                         separators=(",", ":"))

    try:
        chat_response = client.chat.parse(
            timeout_ms=LLM_CALL_TIMEOUT_MS,
            model=MISTRAL_CHAT_MODEL,
            temperature=0,
            messages=[
                {"role": "system", "content": TRANSLATE_PROMPT},
                {"role": "user", "content": payload},
            ],
            response_format=StandardizedVisitData,
            max_tokens=16000,
        )
    except Exception as e:
        logger.error("Translate LLM call failed: %s", e)
        return _fallback_translate(raw_visit_data)

    content = chat_response.choices[0].message.content

    if isinstance(content, str):
        try:
            parsed = json.loads(content)
            return StandardizedVisitData(**parsed)
        except (json.JSONDecodeError, Exception) as e:
            logger.error("Failed to parse translate response: %s", e)
            return _fallback_translate(raw_visit_data)

    return content


def _fallback_translate(vd) -> StandardizedVisitData:
    return StandardizedVisitData(
        diagnosis=_tx(vd.diagnosis if hasattr(vd, 'diagnosis') else ""),
        chief_complaint=_tx(vd.chief_complaint if hasattr(vd, 'chief_complaint') else ""),
        objective_findings=_tx(vd.objective_findings if hasattr(vd, 'objective_findings') else ""),
        prescriptions=[
            StandardizedPrescription(
                name=_tx(p.name),
                dosage=_tx(p.dosage),
                instructions=_tx(p.instructions),
            )
            for p in (vd.prescriptions or [])
        ],
        recommendations=[_tx(r) for r in (vd.recommendations or [])],
    )
