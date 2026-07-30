import hashlib
import json
import logging
import math
import os
import re
import unicodedata
from datetime import datetime
from typing import List, Optional, Tuple, Union

from mistralai import Mistral
from rapidfuzz import fuzz, process
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.seed_loinc import LOINC_NAME_OVERRIDES

from app.services import converters
from app.services.reference import (
    _ABSENT_CANONICAL,
    compute_status,
    merge_reference,
    normalize_qual,
    parse_reference,
    parse_value,
)
from app.schemas.ai import (
    ConversionFactor,
    LoincGuess,
    LoincGuessBatch,
    MatchVerification,
    MatchVerificationBatch,
    RawBiomarker,
    RawMedicalRecord,
    RawVisitData,
    ScaleFunction,
    StandardizedMedicalRecord,
    StandardizedBiomarker,
    StandardizedVisitData,
    StandardizedPrescription,
    TranslatedText,
    UnitTranslation,
    UnitTranslationBatch,
)
from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel

logger = logging.getLogger(__name__)

# Fuzzy-match acceptance threshold (0-100). Above this we accept a match
# without consulting the LLM.
FUZZY_ACCEPT_SCORE = 90
# In addition to the WRatio cutoff, a fuzzy candidate must reach this
# length-sensitive Levenshtein ratio. This blocks cross-analyte partial matches
# (e.g. "Erythrocyte sedimentation rate" -> "Erythrocyte", "ESR" -> "SR") that
# WRatio/token_set_ratio score deceptively high on shared substrings/subset
# tokens, while still allowing genuine qualifier matches like
# "Total bilirubin" -> "Bilirubin" or "Glucose fasting" -> "Glucose".
FUZZY_RATIO_MIN = 55
# Reject fuzzy hits on ultra-short index keys (2-char abbreviations) unless the
# query matches them exactly — they are too ambiguous to match fuzzily.
MIN_FUZZY_KEY_LEN = 3
# Number of candidate definitions to offer the LLM per unmatched biomarker.
LLM_CANDIDATE_COUNT = 8

# Unit tokens that denote a percentage / fraction-of-100 measurement, as opposed
# to an absolute count. Used to route percent results to the fraction ("… %")
# LOINC variant rather than the absolute-count variant.
_PERCENT_UNITS = {"%", "percent", "pct", "10*2/%", "10*2/100", "%/100", "pc"}


def _is_percent_unit(unit: Optional[str]) -> bool:
    """True when the raw document unit expresses a percentage (not an absolute count)."""
    if not unit:
        return False
    norm = converters.normalize_unit(unit)
    token = norm.strip().lower()
    if token in _PERCENT_UNITS:
        return True
    # Also catch trailing "%" after a number-like or ratio token, e.g. "1/100".
    return token.endswith("%") or token.endswith("/100")

LOINC_CSV = os.path.join(os.path.dirname(__file__), "..", "..", "data", "Loinc.csv")

ZERO_SHOT_PROMPT = """You are a medical terminology assistant. For each raw biomarker extracted from a medical document, choose the single best matching LOINC code.

Each item lists the raw name and a set of candidate LOINC codes (code: English name) retrieved for it. Pick the candidate that best matches the analyte. If NONE of the candidates fit, set guessed_loinc to null.

Items:
{items}

Return a JSON array of objects, one per input name in the same order, each with:
- raw_name: the original name from the input (copy verbatim)
- standard_name_en: the standard English name of the analyte
- guessed_loinc: the chosen candidate LOINC code, or null if none fit"""


_loinc_row_cache: Optional[dict[str, dict]] = None


def _load_loinc_rows() -> dict[str, dict]:
    """Lazily load LOINC_NUM -> row from the full LOINC CSV (cached)."""
    global _loinc_row_cache
    if _loinc_row_cache is not None:
        return _loinc_row_cache
    import csv

    rows: dict[str, dict] = {}
    path = os.path.abspath(LOINC_CSV)
    try:
        with open(path, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                code = (row.get("LOINC_NUM") or "").strip()
                if code:
                    rows[code] = row
    except OSError as e:
        logger.warning("Could not load LOINC CSV for promotion: %s", e)
    _loinc_row_cache = rows
    return rows


def _promote_loinc_from_csv(db: Session, code: str) -> Optional[BiomarkerDefinitionModel]:
    """Create a global BiomarkerDefinition from the full LOINC CSV for a code
    that was guessed by the LLM but not present in the seeded subset."""
    from app.db.seed_loinc import row_to_definition

    row = _load_loinc_rows().get(code)
    if not row:
        return None
    try:
        defn_dict = row_to_definition(row)
    except Exception as e:
        logger.warning("Failed to build definition for LOINC %s: %s", code, e)
        return None
    if not defn_dict.get("id"):
        return None
    new_defn = BiomarkerDefinitionModel(**defn_dict)
    db.add(new_defn)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.id == code
        ).first()
    logger.info("Promoted LOINC %s to global definition", code)
    return new_defn


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


def _apply_status(result: StandardizedMedicalRecord) -> None:
    if not result.biomarkers:
        return
    for b in result.biomarkers:
        b.status = compute_status(b.standard_value, b.reference)


# Cache of LLM-supplied conversion factors keyed by (analyte, from_unit, to_unit).
_factor_cache: dict[tuple[str, str, str], Optional[float]] = {}

CONVERSION_FACTOR_PROMPT = (
    "You are a clinical laboratory unit-conversion expert. Provide the numeric "
    "factor to convert a measurement of '{analyte}' from '{from_unit}' to "
    "'{to_unit}', such that value_in_target = value_in_source * factor.\n"
    "Account for molecular weight when converting between mass and molar units.\n"
    "Only set convertible=true when the conversion is well-defined for this "
    "analyte; otherwise set convertible=false and factor=null."
)


def _llm_conversion_factor(
    analyte: str,
    from_unit: str,
    to_unit: str,
    loinc: Optional[str],
    client: Optional[Mistral],
) -> Optional[float]:
    """Ask the LLM only for the conversion FACTOR (not the arithmetic), cached."""
    key = ((loinc or analyte).lower(), from_unit.strip().lower(), to_unit.strip().lower())
    if key in _factor_cache:
        return _factor_cache[key]
    if client is None:
        _factor_cache[key] = None
        return None
    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
            temperature=0,
            messages=[
                {
                    "role": "system",
                    "content": CONVERSION_FACTOR_PROMPT.format(
                        analyte=analyte or "unknown analyte",
                        from_unit=from_unit,
                        to_unit=to_unit,
                    ),
                },
                {"role": "user", "content": "Return the conversion factor now."},
            ],
            response_format=ConversionFactor,
            max_tokens=200,
        )
        content = chat_response.choices[0].message.content
        if isinstance(content, str):
            cf = ConversionFactor(**json.loads(content))
        else:
            cf = content
        factor = cf.factor if cf.convertible else None
    except Exception as e:
        logger.warning("LLM conversion factor failed (%s %s->%s): %s", analyte, from_unit, to_unit, e)
        factor = None
    _factor_cache[key] = factor
    return factor


def convert_units(
    value: float,
    raw_unit: str,
    target_unit: str,
    analyte_name: str = "",
    loinc: Optional[str] = None,
    client: Optional[Mistral] = None,
) -> float:
    """Convert `value` to `target_unit`.

    Deterministic first (dimensional / molecular-mass), then LLM-supplied
    factor as a fallback. Returns the original value if nothing applies.
    """
    if not target_unit or not raw_unit:
        return value

    converted, method = converters.convert_value(value, raw_unit, target_unit, analyte_name)
    if converted is not None and method != "none":
        return converted

    factor = _llm_conversion_factor(analyte_name, raw_unit, target_unit, loinc, client)
    if factor is not None:
        return converters.apply_factor(value, factor)

    logger.warning("No conversion known: %s → %s (%s)", raw_unit, target_unit, analyte_name)
    return value


# Punctuation commonly attached to biomarker names by OCR
_PUNCT_RE = re.compile(r'[,:;.()\[\]{}"\'\-–—/\\|#@!?]\s*$')

def _strip_trailing_punct(name: str) -> str:
    """Strip OCR-attached trailing punctuation and normalise unicode. Case is preserved."""
    name = unicodedata.normalize('NFKC', name)
    return _PUNCT_RE.sub('', name.strip())

def _normalize_name(name: str) -> str:
    """Normalize a biomarker name by stripping punctuation, normalising unicode,
    and lowercasing. Used for case-insensitive matching / hashing / lookup."""
    return _strip_trailing_punct(name).lower()


def _definition_rank(defn: BiomarkerDefinitionModel) -> int:
    """Preference key (lower = better). Uses LOINC COMMON_TEST_RANK so the most
    commonly ordered test wins when several definitions share a synonym."""
    rank = getattr(defn, "common_rank", None)
    return rank if rank is not None else 10**9


def build_name_index(
    definitions: list[BiomarkerDefinitionModel],
) -> dict[str, BiomarkerDefinitionModel]:
    """Map normalized name/synonym -> global definition for O(1) lookup.

    Definitions are ranked so blood/serum concentration tests win collisions
    over urine/stool/ratio variants that share generic synonyms.
    """
    index: dict[str, BiomarkerDefinitionModel] = {}
    # Global definitions are the primary, shared dictionary. System-shared local
    # definitions (user_id IS NULL, e.g. curated local-only analytes like
    # "Activated lymphocytes") are also matchable so they aren't silently lost
    # to a fuzzy global match — but global wins any name collision.
    ranked = sorted(
        (d for d in definitions if d.scope == "global"),
        key=_definition_rank,
    )
    for d in ranked:
        for s in list(d.names.values()) + (d.synonyms or []):
            if not s:
                continue
            key = _normalize_name(s)
            if key and key not in index:
                index[key] = d
    for d in (x for x in definitions if x.user_id is None and x.scope != "global"):
        for s in list(d.names.values()) + (d.synonyms or []):
            if not s:
                continue
            key = _normalize_name(s)
            if key and key not in index:
                index[key] = d
    return index


def _common_biomarker_guide(
    definitions: list[BiomarkerDefinitionModel], limit: int = 40
) -> list[str]:
    """Compact list of the most commonly ordered tests, for the LLM to use as a
    guide when no close candidate exists for an unmatched biomarker."""
    ranked = sorted(
        (d for d in definitions if d.scope == "global" and d.common_rank),
        key=lambda d: d.common_rank,
    )
    out = []
    for d in ranked[:limit]:
        out.append(f'{d.loinc_code}: {d.names.get("en", d.id)}')
    return out


def deterministic_match(
    raw_name: str,
    index: dict[str, BiomarkerDefinitionModel],
    extra_names: tuple[str, ...] = (),
) -> Optional[BiomarkerDefinitionModel]:
    """Exact (normalized) lookup of the raw name or any provided alias."""
    for candidate in (raw_name, *extra_names):
        key = _normalize_name(candidate or "")
        if key and key in index:
            return index[key]
    return None


def fuzzy_match(
    raw_name: str,
    index: dict[str, BiomarkerDefinitionModel],
    extra_names: tuple[str, ...] = (),
    score_cutoff: int = FUZZY_ACCEPT_SCORE,
) -> Optional[BiomarkerDefinitionModel]:
    """Best fuzzy match against the name index, or None below the cutoff.

    WRatio can rank short junk subset synonyms (e.g. "tot", "bili") above the
    real analyte name, so we scan the top WRatio candidates and keep the first
    that also passes a length-sensitive Levenshtein guard. This blocks
    cross-analyte partials ("Erythrocyte sedimentation rate" -> "Erythrocyte")
    while still matching genuine qualifiers ("Total bilirubin" -> "Bilirubin").
    """
    keys = list(index.keys())
    if not keys:
        return None
    best_defn = None
    best_ratio = FUZZY_RATIO_MIN - 1
    for candidate in (raw_name, *extra_names):
        key = _normalize_name(candidate or "")
        if not key:
            continue
        for matched_key, wr, _ in process.extract(
            key, keys, scorer=fuzz.WRatio, limit=15, score_cutoff=score_cutoff
        ):
            if len(matched_key) < MIN_FUZZY_KEY_LEN and matched_key != key:
                continue
            r = fuzz.ratio(key, matched_key)
            if r < FUZZY_RATIO_MIN:
                continue
            if r > best_ratio:
                best_ratio = r
                best_defn = index[matched_key]
    return best_defn


def is_grounded(
    search_name: str,
    index: dict[str, BiomarkerDefinitionModel],
    threshold: int = 80,
) -> bool:
    """True when the (already English) name has a genuinely close entry in the
    index. Used to decide whether an LLM LOINC guess may touch global defs.

    Uses token_set_ratio (stricter than WRatio) so random/garbage names — which
    WRatio can score deceptively high on short substrings — are rejected."""
    key = _normalize_name(search_name or "")
    if not key:
        return False
    keys = list(index.keys())
    if not keys:
        return False
    result = process.extractOne(key, keys, scorer=fuzz.token_set_ratio)
    return bool(result and result[1] >= threshold)


def _candidates_for(
    raw_name: str,
    index: dict[str, BiomarkerDefinitionModel],
    extra_names: tuple[str, ...] = (),
    limit: int = LLM_CANDIDATE_COUNT,
    score_cutoff: int = 60,
) -> list[BiomarkerDefinitionModel]:
    """Top-N candidate definitions (by fuzzy score) for the LLM to choose from.

    Candidates below `score_cutoff` are discarded so the LLM is never shown
    meaningless noise (e.g. a Cyrillic name vs. unrelated English tests)."""
    keys = list(index.keys())
    if not keys:
        return []
    seen: dict[str, BiomarkerDefinitionModel] = {}
    for candidate in (raw_name, *extra_names):
        key = _normalize_name(candidate or "")
        if not key:
            continue
        for match_key, score, _idx in process.extract(
            key, keys, scorer=fuzz.WRatio, limit=limit, score_cutoff=score_cutoff
        ):
            defn = index[match_key]
            if defn.loinc_code and defn.loinc_code not in seen:
                seen[defn.loinc_code] = defn
    ranked = sorted(seen.values(), key=_definition_rank)
    return ranked[:limit]


def _convert_to_canonical(
    value: Union[float, str, None],
    raw_bm: RawBiomarker,
    defn: BiomarkerDefinitionModel,
    client: Optional[Mistral],
) -> tuple[Union[float, str, None], str, Optional[str], bool]:
    """Land `value` in the definition's canonical unit, if any.

    Returns ``(std_value, std_unit, scale_function, needs_review)``. When
    the defn has no canonical unit (legacy / global LOINC), the function is
    a no-op that returns the original value and unit and ``scale_function=None``.
    When the raw unit is missing, the value is non-numeric, or the LLM
    can't decide the conversion, the function returns the original value
    and sets ``needs_review=True`` so the UI can flag it.
    """
    canon_unit = getattr(defn, "canonical_unit", None) or None
    canon_kind = getattr(defn, "canonical_kind", None) or "linear"
    raw_translation = _translated_unit(raw_bm.unit)
    raw_unit_en = raw_translation["unit"]
    raw_kind = raw_translation["kind"]

    # No canonical set yet → no conversion needed (the def is either a
    # legacy LOINC def or a fresh local def whose canonical is about to
    # be populated by ``verify_or_create`` / ``_make_local_copy``).
    if not canon_unit:
        return value, raw_unit_en, None, False

    # If the raw unit is already in the canonical form, no conversion.
    if _units_match(raw_unit_en, canon_unit):
        return value, canon_unit, None, False

    # String values ("Not detected", "не обнар", …) aren't convertible.
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        # Keep the raw value but flag the unit mismatch for the UI.
        return value, canon_unit, None, True

    fn = _llm_scale_function(
        analyte=defn.names.get("en") or raw_bm.standard_name_en or raw_bm.name,
        from_unit=raw_unit_en or "(empty)",
        to_unit=canon_unit,
        from_kind=raw_kind,
        to_kind=canon_kind,
        client=client,
    )
    if not fn:
        # LLM couldn't decide — keep raw, flag for review.
        return value, canon_unit, None, True
    converted = _apply_scale_function(float(value), fn)
    if converted is None:
        return value, canon_unit, None, True
    return converted, canon_unit, fn, False


def _units_match(a: str, b: str) -> bool:
    """Loose comparison: case-insensitive + whitespace-tolerant.

    For our purposes, "copies/mL" == "Copies / mL" and "lg copies/mL"
    == "LG copies/mL". Empty strings never match anything.
    """
    a = (a or "").strip().lower()
    b = (b or "").strip().lower()
    if not a or not b:
        return False
    return a == b


def _build_standardized_from_def(
    raw_bm: RawBiomarker,
    defn: BiomarkerDefinitionModel,
    db: Optional[Session] = None,
    user_id: Optional[str] = None,
    client: Optional[Mistral] = None,
) -> StandardizedBiomarker:
    parsed_value = parse_value(raw_bm.value)

    # Canonicalize the document's own unit (e.g. Cyrillic "ммоль/л" -> "mmol/L").
    doc_unit = converters.normalize_unit(raw_bm.unit)
    doc_reference = parse_reference(raw_bm.raw_range_string)

    # Document-first: when the lab printed its own reference range, trust it and
    # keep the value in the document's own (normalized) unit. This avoids lossy
    # unit conversion and compares like-for-like, preventing false out-of-range
    # flags (e.g. a glucose of 5.5 ммоль/л against the lab's own 3.9-6.1 range).
    if doc_reference is not None:
        # Keep the matched (global) definition and its identity. The document
        # range is carried on the reading itself; `scope` reflects dictionary
        # membership, NOT reference provenance, so a recognized analyte must stay
        # "global" even when we display the lab's own range.
        ref = merge_reference(doc_reference, defn.reference, parsed_value)
        # Keep the value type aligned with the ref kind. For an interval ref
        # the value must be numeric, so a canonical "absent" result
        # ("не обнаружено" / "Negative" / "Absent" / "Normal") collapses to
        # 0.0 — the test was run and the result is below the detection limit.
        # For a qualitative ref, the canonical English term is the right shape.
        if isinstance(parsed_value, str):
            canonical = normalize_qual(parsed_value)
            if ref.get("kind") == "interval" and canonical in _ABSENT_CANONICAL:
                parsed_value = 0.0
            else:
                parsed_value = canonical
        return StandardizedBiomarker(
            raw_name=raw_bm.name,
            raw_value=raw_bm.value,
            raw_unit=raw_bm.unit,
            raw_range_string=raw_bm.raw_range_string,
            standard_name_en=_prefer_comma_pct(defn.names.get("en", raw_bm.name)),
            standard_value=parsed_value,
            standard_unit=doc_unit or defn.unit,
            reference=ref,
            status="",
            category=defn.category,
            definition_id=defn.loinc_code or defn.id,
            scope=defn.scope,
        )

    # No document range: fall back to the curated global reference, converting a
    # numeric value into the definition's canonical unit so the comparison is
    # valid. Qualitative values carry no unit so nothing to convert.
    scale_function: Optional[str] = None
    needs_review = False
    if isinstance(parsed_value, (int, float)) and not isinstance(parsed_value, bool):
        std_value, std_unit, scale_function, needs_review = _convert_to_canonical(
            convert_units(
                parsed_value,
                raw_bm.unit,
                defn.unit,
                analyte_name=defn.names.get("en", raw_bm.name),
                loinc=defn.loinc_code,
                client=client,
            ),
            raw_bm,
            defn,
            client,
        )
    else:
        # Qualitative / non-numeric — still align the unit with the canonical
        # when there is one, so the display stays consistent.
        std_value, std_unit, scale_function, needs_review = _convert_to_canonical(
            parsed_value, raw_bm, defn, client,
        )

    ref = merge_reference(None, defn.reference, std_value)
    if isinstance(ref, dict) and ref.get("kind") == "qualitative":
        std_value = normalize_qual(std_value)
    return StandardizedBiomarker(
        raw_name=raw_bm.name,
        raw_value=raw_bm.value,
        raw_unit=raw_bm.unit,
        raw_range_string=raw_bm.raw_range_string,
        standard_name_en=_prefer_comma_pct(defn.names.get("en", raw_bm.name)),
        standard_value=std_value,
        standard_unit=std_unit,
        reference=ref,
        status="",
        category=defn.category,
        definition_id=defn.loinc_code or defn.id,
        scope=defn.scope,
        scale_function=scale_function,
        needs_review=needs_review,
    )


def _build_standardized_local(
    raw_bm: RawBiomarker,
    defn: BiomarkerDefinitionModel,
    client: Optional[Mistral] = None,
) -> StandardizedBiomarker:
    parsed_value = parse_value(raw_bm.value)
    parsed_ref = parse_reference(raw_bm.raw_range_string)
    # A parsed interval ref means the document reported a numeric range, so
    # the biomarker is Quantitative. Keep the value type aligned with the ref:
    # numeric values stay as numbers, and a canonical "absent" result
    # ("не обнаружено" / "Negative" / "Absent" / "Normal") collapses to 0.0 so
    # it composes with the interval bounds in `compute_status`. Present results
    # against an interval ref have no known count and are kept as the raw
    # canonical string.
    if isinstance(parsed_ref, dict) and parsed_ref.get("kind") == "interval":
        if isinstance(parsed_value, str):
            canonical = normalize_qual(parsed_value)
            std_value = 0.0 if canonical in _ABSENT_CANONICAL else canonical
        else:
            std_value = parsed_value
    else:
        std_value = normalize_qual(parsed_value)

    # Cross-scale conversion: if the defn has a canonical unit (set on the
    # first reading that defined it) and the current reading's translated
    # unit differs, ask the LLM for the scale function (10^x, log10, …)
    # and apply it. Numeric values are converted; string values are kept raw
    # but flagged with `needs_review` so the UI can highlight the mismatch.
    std_value, std_unit, scale_function, needs_review = _convert_to_canonical(
        std_value, raw_bm, defn, client,
    )

    # Prefer the translated English name; fall back to the original raw name if
    # the stored definition name is somehow still non-English (defense against
    # an untranslated local definition leaking the source language to the UI).
    en = defn.names.get("en") or raw_bm.standard_name_en or raw_bm.name
    if not _is_ascii(en):
        en = raw_bm.standard_name_en or raw_bm.name

    ref = merge_reference(parsed_ref, defn.reference, std_value)
    return StandardizedBiomarker(
        raw_name=raw_bm.name,
        raw_value=raw_bm.value,
        raw_unit=raw_bm.unit,
        raw_range_string=raw_bm.raw_range_string,
        standard_name_en=_prefer_comma_pct(en),
        standard_value=std_value,
        standard_unit=std_unit,
        reference=ref,
        status="",
        category=defn.category or raw_bm.category or "General",
        definition_id=defn.loinc_code or defn.id,
        scope=defn.scope,
        scale_function=scale_function,
        needs_review=needs_review,
    )


_TRANSLATE_PROMPT = """You are a medical terminology translator. For each biomarker name extracted from a medical document, provide the standard English analyte name (e.g. "Билирубин общий" -> "Total bilirubin", "Bilirrubina total" -> "Total bilirubin").

Items:
{items}

Return a JSON array of objects, one per input in the same order, each with:
- raw_name: the original name (copy verbatim)
- standard_name_en: the standard English analyte name, or the original if it is already English"""


def _is_ascii(text: str) -> bool:
    try:
        text.encode("ascii")
        return True
    except (UnicodeEncodeError, AttributeError):
        return False


def _prefer_comma_pct(name: str) -> str:
    """Display convention: a fraction analyte reads "X, %" (comma before the
    percent sign), not "X %". Names already following the convention are left
    untouched. This only affects the *displayed* standardized name — the stored
    definition name keeps "X %" so fuzzy/index matching stays stable."""
    if name and name.endswith(" %") and not name.endswith(", %"):
        return name[:-2].rstrip() + ", %"
    return name


def _translate_names_batch(
    biomarkers: list[RawBiomarker],
    client: Mistral,
) -> dict[str, str]:
    """Translate non-English biomarker names to English via a single LLM call.

    Returns a mapping raw_name -> standard English analyte name for the names
    that were translated. Names already in ASCII are skipped (assumed English).
    """
    need: list[RawBiomarker] = []
    for b in biomarkers:
        en = (b.standard_name_en or "").strip()
        if en and _is_ascii(en):
            continue
        if b.name and not _is_ascii(b.name):
            need.append(b)
    if not need or client is None:
        return {}

    item_lines = "\n".join(f'- "{b.name}"' for b in need)
    system_prompt = _TRANSLATE_PROMPT.format(items=item_lines)
    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
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
        if isinstance(content, str):
            parsed = LoincGuessBatch(**json.loads(content))
        else:
            parsed = content
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


_UNIT_TRANSLATE_PROMPT = """You are a clinical-laboratory unit normaliser. For each unit string below, return the standard English form used in medical lab reports.

Rules:
- Translate Russian / Belarusian / non-ASCII units into conventional English (e.g. "копий/мл" -> "copies/mL", "мг/дл" -> "mg/dL", "ммоль/л" -> "mmol/L", "г/л" -> "g/L").
- Preserve log-scale prefixes ("lg", "log", "ln") and translate only the magnitude part (e.g. "lg копий/мл" -> "lg copies/mL", "ln копий/мл" -> "ln copies/mL", "log10 копий/мл" -> "lg copies/mL").
- For an EMPTY unit string, invent a sensible unit based on the analyte name and category (e.g. stool microbiome panels without a unit cell usually mean "copies/mL" or "copies/g"). Set `inferred: true` when you do.
- For already-English units, return them verbatim and set `inferred: false`.
- `kind` is "linear" by default, "log10" if the unit starts with "lg" / "log10" / "log" (case-insensitive), "ln" if the unit starts with "ln" (natural log).

Items (each line: english analyte name | category | raw unit):
{items}

Return a JSON array of objects, one per input in the same order, each with:
- raw_unit: the original unit (copy verbatim, or "" for empty)
- unit: the standard English unit (or "" if you can't decide)
- kind: "linear" | "log10" | "ln"
- inferred: true if the unit was invented (no source unit), false otherwise"""


# Cache of unit translations for the duration of a single match_and_convert call.
_unit_translation_cache: dict[str, dict] = {}


def _heuristic_unit_translation(
    raw_unit: str, analyte_name: str = "", category: str = ""
) -> Optional[dict]:
    """Cheap deterministic translation for units the parser can already
    recognise. Returns a UnitTranslation-shaped dict or None when the unit
    needs the LLM (e.g. Cyrillic / invented for empty)."""
    u = (raw_unit or "").strip()
    if not u:
        return None  # needs LLM to invent from analyte/category
    # The Cyrillic lowercase letters mean the LLM has to translate; skip.
    if not _is_ascii(u):
        return None
    low = u.lower()
    kind = "linear"
    if low.startswith(("lg", "log10", "log ")) or low == "log":
        kind = "log10"
    elif low.startswith("ln"):
        kind = "ln"
    return {"unit": u, "kind": kind, "inferred": False}


def _translated_unit(raw_unit: str) -> dict:
    """Return the cached translation for ``raw_unit``, or fall back to a
    plain identity translation (with kind inferred from the prefix).

    Never raises: an unrecognised unit always yields a usable dict.
    """
    u = (raw_unit or "").strip()
    entry = _unit_translation_cache.get(u)
    if entry is not None:
        return entry
    # Fall back to a heuristic identity translation. This only runs for units
    # that never reached the batch translator (e.g. when the LLM client
    # was unavailable).
    low = u.lower()
    kind = "linear"
    if low.startswith(("lg", "log10", "log ")) or low == "log":
        kind = "log10"
    elif low.startswith("ln"):
        kind = "ln"
    return {"unit": u, "kind": kind, "inferred": False}


def _translate_units_batch(
    biomarkers: list[RawBiomarker],
    client: Mistral,
) -> dict[str, dict]:
    """Translate non-English / empty / ambiguous units to standard English
    via a single LLM call. Returns {raw_unit: {"unit", "kind", "inferred"}}.

    Already-English units with a recognised scale prefix are handled
    heuristically (no LLM call) so the helper is fast on the common case.
    """
    needed: dict[str, dict] = {}  # raw_unit -> {analyte, category}
    for b in biomarkers:
        u = (b.unit or "").strip()
        cache = _unit_translation_cache.get(u)
        if cache is not None:
            needed.pop(u, None)
            continue
        heur = _heuristic_unit_translation(u, b.name, b.category)
        if heur is not None:
            _unit_translation_cache[u] = heur
            continue
        needed[u] = {"name": b.standard_name_en or b.name, "category": b.category}

    if not needed or client is None:
        return {}

    items = "\n".join(
        f'- {meta["name"] or "?"} | {meta["category"] or "General"} | {raw!r}'
        for raw, meta in needed.items()
    )
    system_prompt = _UNIT_TRANSLATE_PROMPT.format(items=items)
    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Return the JSON array now."},
            ],
            response_format=UnitTranslationBatch,
            max_tokens=1000,
        )
    except Exception as e:
        logger.error("Unit translation LLM call failed: %s", e)
        return {}

    content = chat_response.choices[0].message.content
    try:
        if isinstance(content, str):
            parsed = UnitTranslationBatch(**json.loads(content))
        else:
            parsed = content
    except (json.JSONDecodeError, Exception) as e:
        logger.error("Failed to parse unit translation response: %s", e)
        return {}

    result: dict[str, dict] = {}
    for g, (raw_unit, _) in zip(parsed.translations, needed.items()):
        unit = (g.unit or "").strip()
        kind = (g.kind or "linear").strip().lower() or "linear"
        if kind not in ("linear", "log10", "ln"):
            kind = "linear"
        entry = {"unit": unit, "kind": kind, "inferred": bool(g.inferred)}
        _unit_translation_cache[raw_unit] = entry
        result[raw_unit] = entry
    return result


# Cache of scale-function conversions for the duration of a single
# match_and_convert call. Keyed by (analyte, from_unit, to_unit, from_kind,
# to_kind) all lowercased.
_scale_function_cache: dict[tuple, str] = {}


_SCALE_FUNCTION_PROMPT = """You are a clinical laboratory scale-conversion expert.

Convert a numeric measurement of `<analyte>` from `<from_unit>` to `<to_unit>`.
The source scale is `<from_kind>` (linear | log10 | ln) and the target scale is `<to_kind>` (linear | log10 | ln).

Return ONE of:
- "10^x" — to convert from log10-scale to linear (e.g. 9 lg copies/mL -> 10^9 = 1e9 copies/mL).
- "log10" — to convert from linear to log10-scale.
- "exp(x)" — to convert from ln-scale to linear.
- "ln" — to convert from linear to ln-scale.
- "factor:<number>" — for a linear multiplicative conversion (e.g. 5 g -> 5000 mg is "factor:1000"). The factor is `value_in_target = value_in_source * factor`.
- "" (empty string) — if the conversion is not well-defined for this analyte (e.g. incompatible magnitudes, or you are uncertain).

Return a JSON object: {{"function": "<one of the above>"}}."""


def _llm_scale_function(
    analyte: str,
    from_unit: str,
    to_unit: str,
    from_kind: str,
    to_kind: str,
    client: Optional[Mistral],
) -> str:
    """Return "10^x" / "log10" / "exp(x)" / "ln" / "factor:<float>" / "".

    Cached for the request. Returns "" on failure or when the LLM can't
    decide (the caller is expected to surface that as ``needs_review``).
    """
    key = (
        (analyte or "").lower(),
        (from_unit or "").lower(),
        (to_unit or "").lower(),
        from_kind,
        to_kind,
    )
    if key in _scale_function_cache:
        return _scale_function_cache[key]
    if client is None:
        _scale_function_cache[key] = ""
        return ""
    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
            temperature=0,
            messages=[
                {
                    "role": "system",
                    "content": _SCALE_FUNCTION_PROMPT.format(
                        analyte=analyte or "unknown analyte",
                        from_unit=from_unit or "(empty)",
                        to_unit=to_unit or "(empty)",
                        from_kind=from_kind,
                        to_kind=to_kind,
                    ),
                },
                {"role": "user", "content": "Return the JSON now."},
            ],
            response_format=ScaleFunction,
            max_tokens=200,
        )
        content = chat_response.choices[0].message.content
        if isinstance(content, str):
            sf = ScaleFunction(**json.loads(content))
        else:
            sf = content
        fn = (sf.function or "").strip()
    except Exception as e:
        logger.warning(
            "LLM scale function failed (%s %s/%s -> %s/%s): %s",
            analyte, from_kind, from_unit, to_kind, to_unit, e,
        )
        fn = ""
    _scale_function_cache[key] = fn
    return fn


def _apply_scale_function(value: float, function: str) -> Optional[float]:
    """Apply a scale function string to a numeric value. Returns None when
    the function string is empty or malformed (caller treats as failure)."""
    if not function or not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        if function == "10^x":
            return 10.0 ** float(value)
        if function == "log10":
            v = float(value)
            return None if v <= 0 else math.log10(v)
        if function == "exp(x)":
            return math.exp(float(value))
        if function == "ln":
            v = float(value)
            return None if v <= 0 else math.log(v)
        if function.startswith("factor:"):
            return float(value) * float(function.split(":", 1)[1])
        # Unknown function (empty / junk) → caller should treat as failure.
        return None
    except (ValueError, OverflowError):
        return None


# Cache of multilingual synonym lookups (name -> loinc_code) for the request.
_loinc_alias_cache: Optional[dict[str, str]] = None


def _load_loinc_aliases() -> dict[str, str]:
    """Folded-code -> survivor-code map produced by the seed's dedupe step.

    Lets a curated multilingual code that was deduplicated away still resolve to
    the surviving canonical definition instead of being promoted as a duplicate."""
    global _loinc_alias_cache
    if _loinc_alias_cache is not None:
        return _loinc_alias_cache
    path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "data", "loinc_aliases.json")
    )
    try:
        with open(path, encoding="utf-8") as f:
            _loinc_alias_cache = json.load(f)
    except (OSError, json.JSONDecodeError):
        _loinc_alias_cache = {}
    return _loinc_alias_cache


def _is_fraction_def(defn: BiomarkerDefinitionModel) -> bool:
    """True when the definition is the percent/fraction form of an analyte."""
    en = (defn.names or {}).get("en", "")
    return isinstance(en, str) and en.endswith("%")


def _fraction_variant(
    match: BiomarkerDefinitionModel, definitions: list[BiomarkerDefinitionModel]
) -> Optional[BiomarkerDefinitionModel]:
    """If `match` is the absolute-count form, return the sibling "… %" (fraction)
    variant so a percent document unit resolves to the fraction analyte.

    Searches across ALL definitions (global and local) rather than only the
    global name index, so the re-route still fires when the fraction variant is
    a locally-seeded/LOINC-promoted definition that is not yet in the index.
    """
    name = (match.names or {}).get("en", "")
    if not name or name.endswith("%"):
        return None
    frac_name = f"{name} %".lower()
    for d in definitions:
        if d.id != match.id and (d.names or {}).get("en", "").lower() == frac_name:
            return d
    return None


def _load_multilingual_lookup() -> dict[str, str]:
    """Flat (lowercased) multilingual name -> LOINC code map."""
    path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "data", "multilingual_synonyms.json")
    )
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    lookup: dict[str, str] = {}
    for _lang, mapping in data.items():
        for name, code in mapping.items():
            lookup[name.strip().lower()] = code
            # Also index a punctuation-normalized variant so OCR noise like
            # "СОЭ (по Вестергрену)" or trailing punctuation still resolves.
            lookup.setdefault(_normalize_name(name), code)
    return lookup


# Strips a trailing parenthetical / qualifier so noisy names like
# "СОЭ (по Вестергрену)" or "Эозинофилы, %" still hit the curated table.
_QUALIFIER_RE = re.compile(r"[\(,].*$")


def _multilingual_code(name: str, multilang: dict[str, str]) -> Optional[str]:
    """Look up a localized name in the curated table, tolerating OCR noise."""
    if not name:
        return None
    candidates = [
        name.strip().lower(),
        _normalize_name(name),
        _normalize_name(_QUALIFIER_RE.sub("", name)),
    ]
    for key in candidates:
        if key and key in multilang:
            return multilang[key]
    return None


_VERIFY_PROMPT = """You are a clinical laboratory expert auditing an automated biomarker matcher.
For each item you are given the ORIGINAL biomarker name as printed on the lab report (often non-English) and the analyte it was MATCHED to. Decide whether the match names the SAME clinical analyte.

Be strict about analytes that are commonly confused but distinct, e.g.:
- Erythrocytes (red blood cells) vs. Potassium vs. Nucleated erythrocytes (normoblasts)
- Total vs. Direct vs. Indirect bilirubin
- Absolute counts vs. percentages of the same cell type

Items:
{items}

Return a JSON object with key "verifications": an array with one object per input in the same order, each with:
- raw_name: the ORIGINAL name, copied verbatim
- agree: true if the match is the correct analyte, false otherwise
- corrected_name_en: when agree is false, the correct standard English analyte name (else "")
- corrected_loinc: when agree is false and you are confident, the correct LOINC code (else "")"""


def _verify_and_correct(
    matched_pairs: list[tuple[RawBiomarker, BiomarkerDefinitionModel]],
    index: dict[str, BiomarkerDefinitionModel],
    db: Session,
    client: Mistral,
) -> tuple[list[tuple[RawBiomarker, BiomarkerDefinitionModel]], list[RawBiomarker]]:
    """Audit each match with a single LLM call; correct or reject wrong ones.

    Returns ``(kept_pairs, rejected_raw)``. A disagreement is only overridden by
    an LLM correction that RE-VALIDATES against a real global definition
    (grounded); a correction that cannot be grounded causes the biomarker to be
    rejected back into the unmatched pool rather than shown incorrectly.
    """
    item_lines = "\n".join(
        f'- raw_name: "{b.name}" | matched_to: "{defn.names.get("en", defn.id)}"'
        f' (LOINC {defn.loinc_code})'
        for b, defn in matched_pairs
    )
    system_prompt = _VERIFY_PROMPT.format(items=item_lines)
    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Return the JSON now."},
            ],
            response_format=MatchVerificationBatch,
            max_tokens=4000,
        )
    except Exception as e:
        logger.error("Match verification LLM call failed: %s", e)
        return matched_pairs, []

    content = chat_response.choices[0].message.content
    try:
        if isinstance(content, str):
            batch = MatchVerificationBatch(**json.loads(content))
        else:
            batch = content
    except (json.JSONDecodeError, Exception) as e:
        logger.error("Failed to parse verification response: %s", e)
        return matched_pairs, []

    by_raw: dict[str, MatchVerification] = {v.raw_name: v for v in batch.verifications}

    kept: list[tuple[RawBiomarker, BiomarkerDefinitionModel]] = []
    rejected: list[RawBiomarker] = []
    for b, defn in matched_pairs:
        v = by_raw.get(b.name)
        if v is None or v.agree:
            kept.append((b, defn))
            continue

        # Disagreement: try to ground the LLM's proposed correction.
        corrected = _resolve_correction(v, index, db)
        if corrected is not None and corrected.loinc_code != defn.loinc_code:
            logger.info(
                "Verifier corrected %r: %s -> %s",
                b.name, defn.loinc_code, corrected.loinc_code,
            )
            kept.append((b, corrected))
        else:
            logger.info(
                "Verifier rejected %r matched to %s (no grounded correction)",
                b.name, defn.loinc_code,
            )
            rejected.append(b)
    return kept, rejected


def _resolve_correction(
    v: MatchVerification,
    index: dict[str, BiomarkerDefinitionModel],
    db: Session,
) -> Optional[BiomarkerDefinitionModel]:
    """Ground an LLM correction to a real global definition, or return None."""
    if v.corrected_loinc:
        hit = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.loinc_code == v.corrected_loinc,
            BiomarkerDefinitionModel.scope == "global",
        ).first()
        if hit is None:
            hit = _promote_loinc_from_csv(db, v.corrected_loinc)
        if hit is not None:
            return hit
    name = (v.corrected_name_en or "").strip()
    if name:
        return deterministic_match(name, index) or fuzzy_match(name, index)
    return None


def _llm_zero_shot_batch(
    unmatched: list[RawBiomarker],
    index: dict[str, BiomarkerDefinitionModel],
    client: Mistral,
    common_map: Optional[list[str]] = None,
) -> list[LoincGuess]:
    # Build a compact per-biomarker candidate list instead of dumping the
    # entire (5000+ entry) LOINC dictionary into the prompt.
    item_lines: list[str] = []
    for b in unmatched:
        extra = (b.standard_name_en,) if b.standard_name_en else ()
        candidates = _candidates_for(b.name, index, extra)
        if candidates:
            cand_str = "; ".join(
                f'{c.loinc_code}: {c.names.get("en", c.id)}' for c in candidates
            )
        elif common_map:
            # No close candidate: give the LLM a small guide of common tests so
            # it can still pick sensibly instead of guessing blindly.
            cand_str = "no close match; common tests: " + "; ".join(common_map[:25])
        else:
            cand_str = "(no candidates)"
        item_lines.append(f'- raw_name: "{b.name}" | candidates: {cand_str}')

    items = "\n".join(item_lines)
    system_prompt = ZERO_SHOT_PROMPT.format(items=items)

    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Return the JSON array now."},
            ],
            response_format=LoincGuessBatch,
            max_tokens=4000,
        )
    except Exception as e:
        logger.error("Zero-shot LLM call failed: %s", e)
        return []

    content = chat_response.choices[0].message.content

    if isinstance(content, str):
        try:
            parsed = json.loads(content)
            batch = LoincGuessBatch(**parsed)
        except (json.JSONDecodeError, Exception) as e:
            logger.error("Failed to parse zero-shot response: %s", e)
            return []
    else:
        batch = content

    return batch.guesses


def _guess_is_consistent(
    defn: BiomarkerDefinitionModel,
    raw_biomarker: Optional[RawBiomarker],
) -> bool:
    """Sanity-check an LLM LOINC guess against the biomarker's English name.

    Prevents blatantly wrong promotions (e.g. Bilirubin -> Calcium): the guessed
    definition's English name must fuzzily agree with the extracted English
    analyte name. When no English name is available we can't validate, so we
    accept (the caller only reaches here for grounded guesses).
    """
    en = (raw_biomarker.standard_name_en or "").strip() if raw_biomarker else ""
    if not en:
        return True
    def_name = defn.names.get("en", "") or ""
    names = [def_name] + list(defn.synonyms or [])
    best = max(
        (fuzz.WRatio(_normalize_name(en), _normalize_name(n)) for n in names if n),
        default=0,
    )
    return best >= 70


def verify_or_create(
    db: Session,
    raw_name: str,
    guessed_loinc: Optional[str],
    user_id: str,
    raw_biomarker: Optional[RawBiomarker] = None,
    grounded: bool = True,
) -> BiomarkerDefinitionModel:
    # Only trust an LLM LOINC guess when it was grounded in real candidates AND
    # is consistent with the analyte's English name. Ungrounded / inconsistent
    # guesses must never touch the shared global dictionary — they fall through
    # to a user-local definition (fixes the "Билирубин -> Calcium" bug).
    if guessed_loinc and grounded:
        existing = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.loinc_code == guessed_loinc,
            BiomarkerDefinitionModel.scope == "global",
        ).first()
        if existing is None:
            existing = _promote_loinc_from_csv(db, guessed_loinc)
        if existing is not None and _guess_is_consistent(existing, raw_biomarker):
            # Never fold a raw name onto a percent/fraction definition as a
            # synonym — that is how absolute ("… абс.") readings got merged into
            # the "%" analyte. Other (non-fraction) definitions keep learning
            # synonyms for matching recall.
            if not _is_fraction_def(existing):
                syns = list(existing.synonyms or [])
                raw_lower = raw_name.lower()
                if raw_lower not in (s.lower() for s in syns):
                    syns.append(raw_name)
                    existing.synonyms = syns
                    db.flush()
            return existing
        # Not consistent or couldn't resolve — fall through to local.

    # Fallback: match by name or synonym against global definitions
    raw_norm = _normalize_name(raw_name)
    for defn in db.query(BiomarkerDefinitionModel).filter(
        BiomarkerDefinitionModel.scope == "global"
    ).all():
        for n in defn.names.values():
            if n and _normalize_name(n) == raw_norm:
                if not _is_fraction_def(defn):
                    syns = list(defn.synonyms or [])
                    if raw_name.lower() not in (s.lower() for s in syns):
                        syns.append(raw_name)
                        defn.synonyms = syns
                        db.flush()
                return defn
        for syn in (defn.synonyms or []):
            if syn and _normalize_name(syn) == raw_norm:
                if not _is_fraction_def(defn):
                    syns = list(defn.synonyms or [])
                    if raw_name.lower() not in (s.lower() for s in syns):
                        syns.append(raw_name)
                        defn.synonyms = syns
                        db.flush()
                return defn

    # Use the normalized name (trailing punctuation stripped + lowercased) for
    # the def id so that cosmetic variants like "Bifidobacterium spp" and
    # "Bifidobacterium spp." (period present or missing in the OCR) collapse to
    # the same local definition instead of creating duplicates. The original
    # raw name is still stored as a synonym so future exact-match by the raw
    # form still works.
    canonical_name = _normalize_name(raw_name)
    defn_id = f"local-{hashlib.md5(canonical_name.encode()).hexdigest()[:12]}"

    # Use the translated English name as the canonical "en" name when
    # available; only strip OCR-attached trailing punctuation so the
    # human-readable casing is preserved.
    en_name = raw_name
    if raw_biomarker and raw_biomarker.standard_name_en and _is_ascii(
        raw_biomarker.standard_name_en
    ):
        en_name = _strip_trailing_punct(raw_biomarker.standard_name_en.strip())
    syns = [raw_name]
    if en_name and en_name != raw_name and en_name not in syns:
        syns.append(en_name)

    # Parse reference from raw biomarker if available; a non-numeric value forces
    # a qualitative reference.
    reference = None
    unit = ""
    # Canonical (English) unit + scale kind, used as the conversion target
    # for any later reading of the same biomarker. Set on the first reading
    # that creates the def, so e.g. a 25.06 row with an empty unit cell
    # anchors the canonical to whatever the LLM invents (typically
    # "copies/mL"); a 13.05 row with "lg копий/мл" is then converted into
    # that canonical via ``_llm_scale_function``.
    canonical_unit: Optional[str] = None
    canonical_kind = "linear"
    canonical_unit_inferred = False
    if raw_biomarker:
        doc_ref = parse_reference(raw_biomarker.raw_range_string)
        parsed_val = parse_value(raw_biomarker.value)
        reference = merge_reference(doc_ref, None, parsed_val)
        unit = raw_biomarker.unit
        translation = _translated_unit(raw_biomarker.unit)
        # An empty LLM translation means the helper couldn't decide (e.g. the
        # LLM client was unavailable). Fall back to the raw unit so the
        # canonical is still usable downstream.
        canonical_unit = translation["unit"] or raw_biomarker.unit
        canonical_kind = translation["kind"]
        canonical_unit_inferred = bool(translation["inferred"])

    new_defn = BiomarkerDefinitionModel(
        id=defn_id,
        names={"en": en_name},
        synonyms=syns,
        category=raw_biomarker.category if raw_biomarker else "General",
        reference=reference,
        unit=unit,
        scope="local",
        user_id=user_id,
        reference_source="pdf_extracted",
        canonical_unit=canonical_unit,
        canonical_kind=canonical_kind,
        canonical_unit_inferred=canonical_unit_inferred,
    )
    db.add(new_defn)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.id == defn_id
        ).first()
        if existing:
            return existing
        raise
    return new_defn


def _make_local_copy(
    db: Session,
    user_id: str,
    source: Optional[BiomarkerDefinitionModel],
    raw_biomarker: RawBiomarker,
) -> BiomarkerDefinitionModel:
    """Create a user-local definition for an ungrounded guess.

    Copies metadata from a global `source` when available (so the user still
    gets units/ranges), but keeps it in `scope='local'` so a wrong LLM guess
    never pollutes the shared global dictionary.
    """
    # Use the normalized name (trailing punctuation stripped) for the def id
    # so cosmetic variants collapse to the same local definition. See
    # ``verify_or_create`` for the full rationale.
    canonical_name = _normalize_name(raw_biomarker.name)
    defn_id = f"local-{hashlib.md5(canonical_name.encode()).hexdigest()[:12]}"
    existing = db.query(BiomarkerDefinitionModel).filter(
        BiomarkerDefinitionModel.id == defn_id
    ).first()
    if existing:
        return existing

    if source is not None:
        names = dict(source.names or {"en": raw_biomarker.name})
        synonyms = list(source.synonyms or [])
        unit = source.unit or ""
        category = source.category or (raw_biomarker.category or "General")
    else:
        # Prefer the translated English name as the canonical "en" name; keep
        # the original source-language name as a synonym for future matching.
        # Only strip OCR-attached trailing punctuation so the human-readable
        # casing is preserved.
        en_name = raw_biomarker.name
        if raw_biomarker.standard_name_en and _is_ascii(
            raw_biomarker.standard_name_en
        ):
            en_name = _strip_trailing_punct(raw_biomarker.standard_name_en.strip())
        names = {"en": en_name}
        synonyms = [raw_biomarker.name]
        if en_name and en_name != raw_biomarker.name and en_name not in synonyms:
            synonyms.append(en_name)
        unit = raw_biomarker.unit or ""
        category = raw_biomarker.category or "General"

    if raw_biomarker.name not in synonyms:
        synonyms.append(raw_biomarker.name)

    doc_ref = parse_reference(raw_biomarker.raw_range_string)
    parsed_val = parse_value(raw_biomarker.value)
    source_ref = source.reference if source is not None else None
    reference = merge_reference(doc_ref, source_ref, parsed_val)

    # Canonical (English) unit on first sight — anchors the conversion for
    # any later reading of the same biomarker. See ``verify_or_create`` for
    # the matching rationale.
    translation = _translated_unit(raw_biomarker.unit)
    canonical_unit = translation["unit"] or raw_biomarker.unit
    canonical_kind = translation["kind"]
    canonical_unit_inferred = bool(translation["inferred"])

    local = BiomarkerDefinitionModel(
        id=defn_id,
        names=names,
        synonyms=synonyms,
        category=category,
        reference=reference,
        unit=unit,
        scope="local",
        user_id=user_id,
        reference_source=source.reference_source if source is not None else "pdf_extracted",
        canonical_unit=canonical_unit,
        canonical_kind=canonical_kind,
        canonical_unit_inferred=canonical_unit_inferred,
    )
    db.add(local)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.id == defn_id
        ).first()
        if existing:
            return existing
        raise
    return local


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

    payload = raw_visit_data.model_dump()

    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
            temperature=0,
            messages=[
                {"role": "system", "content": TRANSLATE_PROMPT},
                {"role": "user", "content": str(payload)},
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


def _fallback_standardize(raw: RawMedicalRecord) -> StandardizedMedicalRecord:
    biomarkers: list[StandardizedBiomarker] = []
    if raw.biomarkers:
        for b in raw.biomarkers:
            parsed_value = parse_value(b.value)
            parsed_ref = parse_reference(b.raw_range_string)
            # Same Quantitative/Qualitative split as _build_standardized_local:
            # interval ref -> numeric value (canonical "absent" strings
            # collapse to 0.0 so value type matches the ref), qualitative ref
            # -> canonical string.
            if isinstance(parsed_ref, dict) and parsed_ref.get("kind") == "interval":
                if isinstance(parsed_value, str):
                    canonical = normalize_qual(parsed_value)
                    std_value = 0.0 if canonical in _ABSENT_CANONICAL else canonical
                else:
                    std_value = parsed_value
            else:
                std_value = normalize_qual(parsed_value)
            ref = merge_reference(parsed_ref, None, std_value)
            biomarkers.append(StandardizedBiomarker(
                raw_name=b.name,
                raw_value=b.value,
                raw_unit=b.unit,
                raw_range_string=b.raw_range_string,
                standard_name_en=b.name,
                standard_value=std_value,
                standard_unit=b.unit,
                reference=ref,
                status="",
                category=b.category or "General",
            ))

    visit_data = None
    if raw.visit_data:
        if hasattr(raw.visit_data, 'model_dump'):
            visit_data = _fallback_translate(raw.visit_data)
        else:
            visit_data = StandardizedVisitData(
                diagnosis=_tx(raw.visit_data.diagnosis if hasattr(raw.visit_data, 'diagnosis') else str(raw.visit_data)),
                chief_complaint=TranslatedText(),
                objective_findings=TranslatedText(),
                prescriptions=[],
                recommendations=[],
            )

    return StandardizedMedicalRecord(
        entry_type=raw.entry_type,
        date=_normalize_date(raw.date or ""),
        time=_normalize_time(raw.time or ""),
        clinic=raw.clinic,
        provider=raw.provider,
        title=raw.title,
        notes=raw.notes,
        biomarkers=biomarkers,
        visit_data=visit_data,
        imaging_data=raw.imaging_data,
    )


def match_and_convert(
    raw: RawMedicalRecord,
    definitions: list[BiomarkerDefinitionModel],
    db: Session,
    user_id: str,
    client: Mistral,
) -> StandardizedMedicalRecord:
    try:
        return _match_and_convert_impl(raw, definitions, db, user_id, client)
    except Exception as e:
        logger.error("match_and_convert failed: %s", e, exc_info=True)
        result = _fallback_standardize(raw)
        _apply_status(result)
        return result


def _match_and_convert_impl(
    raw: RawMedicalRecord,
    definitions: list[BiomarkerDefinitionModel],
    db: Session,
    user_id: str,
    client: Mistral,
) -> StandardizedMedicalRecord:
    std_biomarkers: list[StandardizedBiomarker] = []
    unmatched: list[RawBiomarker] = []
    matched_pairs: list[tuple[RawBiomarker, BiomarkerDefinitionModel]] = []

    index = build_name_index(definitions)
    biomarkers = list(raw.biomarkers or [])

    # Step 0: Translate non-English names to English so they can reuse the
    # English name index for exact/fuzzy/candidate matching.
    if biomarkers and client:
        _translate_names_batch(biomarkers, client)
        # Also translate units to a canonical English form. This is what
        # lets a later extraction with a different unit (e.g. `lg копий/мл`
        # vs. an empty cell) be converted into the same scale as the
        # first-seen canonical. Results are cached in
        # ``_unit_translation_cache`` for the duration of this call.
        _translate_units_batch(biomarkers, client)

    # Direct multilingual lookup (curated table) — resolves the most common
    # localized names deterministically without any LLM call.
    multilang = _load_multilingual_lookup()
    aliases = _load_loinc_aliases()
    # Biomarkers whose match came from the curated multilingual table. These are
    # treated as high-confidence and are excluded from the (non-deterministic)
    # LLM verification backstop so a loose LLM correction can never override a
    # hand-verified localized mapping.
    curated_ids: set[int] = set()
    # Biomarkers whose curated synonym marks them as local-only (no LOINC) and
    # which must therefore resolve to a per-user local definition, never to a
    # global LOINC guessed by the LLM zero-shot step.
    curated_local_ids: set[int] = set()

    # Step 1: Resolve each biomarker in strict confidence order. Curated signals
    # (the multilingual table + the raw name's own attached synonyms) are the
    # most reliable, so they must win BEFORE any LLM-translation-based match — a
    # loose translation must never hijack a known localized name (e.g.
    # "Эритроциты" -> Erythrocytes, not a mistranslation that hits Potassium).
    for b in biomarkers:
        search_name = (b.standard_name_en or "").strip() or b.name
        extra = (b.name,) if b.name != search_name else ()

        # 1a. Curated multilingual table on the raw localized name.
        match = None
        code = _multilingual_code(b.name, multilang)
        if code:
            # A curated "local-" code marks an analyte that has NO standard
            # LOINC (e.g. "Activated lymphocytes") and is intentionally kept as
            # a per-user local definition. Skip any global LOINC lookup so it
            # can never be merged into a related global analyte (e.g. total
            # Lymphocytes), and let it resolve to a per-user local definition
            # in Step 2. Exclude it from the LLM verification backstop too.
            if code.startswith("local-"):
                unmatched.append(b)
                curated_ids.add(id(b))
                curated_local_ids.add(id(b))
                continue
            # Redirect a curated code that was deduped away to its survivor.
            # Skip this when the code has an explicit display-name override —
            # that marks it as a real, distinct analyte (e.g. 13046-8 variant
            # lymphocytes) which must resolve to itself, not a dedupe survivor.
            if code not in LOINC_NAME_OVERRIDES:
                code = aliases.get(code, code)
            match = db.query(BiomarkerDefinitionModel).filter(
                BiomarkerDefinitionModel.loinc_code == code,
                BiomarkerDefinitionModel.scope == "global",
            ).first()
            # Promote a valid LOINC that exists in the full CSV but wasn't part
            # of the seeded subset (e.g. ESR, Hematocrit). Never fall back to a
            # local "shadow" definition that happens to carry the same LOINC —
            # that would resolve the analyte to a user-local def and surface it
            # as "Unrecognized" instead of the canonical global one.
            if match is None:
                match = _promote_loinc_from_csv(db, code)
            if match is not None:
                curated_ids.add(id(b))

        # 1b. Exact match on the raw name (hits its attached synonyms).
        if match is None:
            match = deterministic_match(b.name, index)

        # 1c. Exact match on the LLM-translated English name.
        if match is None and search_name != b.name:
            match = deterministic_match(search_name, index)

        # 1d. Fuzzy match (guarded) as a last non-LLM resort.
        if match is None:
            match = fuzzy_match(search_name, index, extra)

        # 1e. Unit-aware re-route: a percent result must land on the fraction
        # ("… %") variant of the analyte, not the absolute-count variant. The
        # document unit — not the LOINC property — decides, so "Эозинофилы, %"
        # (unit %) resolves to "Eosinophils %" and never to the absolute code.
        if match and _is_percent_unit(b.unit):
            frac = _fraction_variant(match, definitions)
            if frac is not None:
                match = frac

        if match:
            matched_pairs.append((b, match))
        else:
            unmatched.append(b)

    # Step 1.5: LLM verification backstop. Re-check each (raw name -> matched
    # analyte) pair; accept an LLM correction only when it re-validates against a
    # real global definition (grounded), otherwise send the biomarker back to the
    # unmatched pool so it can be resolved/localized instead of shown wrong.
    # Curated multilingual matches are trusted and skipped (see curated_ids).
    if matched_pairs and client:
        to_verify = [(b, m) for (b, m) in matched_pairs if id(b) not in curated_ids]
        curated_kept = [(b, m) for (b, m) in matched_pairs if id(b) in curated_ids]
        verified, rejected = _verify_and_correct(to_verify, index, db, client)
        matched_pairs = verified + curated_kept
        unmatched.extend(rejected)

    for b, match in matched_pairs:
        std_biomarkers.append(_build_standardized_from_def(b, match, db, user_id, client))

    # Step 2: LLM candidate-based guess for unmatched biomarkers
    if unmatched and client:
        common_map = _common_biomarker_guide(definitions)
        guesses = _llm_zero_shot_batch(unmatched, index, client, common_map)

        raw_to_guess: dict[str, LoincGuess] = {}
        for g in guesses:
            raw_to_guess[g.raw_name] = g

        for b in unmatched:
            guess = raw_to_guess.get(b.name)
            guessed_loinc = guess.guessed_loinc if guess else None

            # A curated local-only analyte (e.g. "Activated lymphocytes") must
            # never be promoted to a global LOINC the LLM happens to guess, even
            # if the guess looks grounded. Force it to a per-user local def.
            if id(b) in curated_local_ids:
                guessed_loinc = None
                grounded = False

            # Was this guess grounded in a real (close) candidate? If not, keep
            # any promotion local so a blind guess can't corrupt global defs.
            search_name = (b.standard_name_en or "").strip() or b.name
            grounded = is_grounded(search_name, index)

            resolved = verify_or_create(
                db, b.name, guessed_loinc, user_id, raw_biomarker=b, grounded=grounded
            )

            if resolved.scope == "global":
                std_biomarkers.append(_build_standardized_from_def(b, resolved, db, user_id, client))
            else:
                std_biomarkers.append(_build_standardized_local(b, resolved, client))
    elif unmatched:
        for b in unmatched:
            resolved = verify_or_create(db, b.name, None, user_id, raw_biomarker=b, grounded=False)
            std_biomarkers.append(_build_standardized_local(b, resolved, client))

    # Step 5: Visit data translation
    visit_data = None
    if raw.visit_data:
        visit_data = _llm_translate_visit_data(raw.visit_data, client)

    result = StandardizedMedicalRecord(
        entry_type=raw.entry_type,
        date=_normalize_date(raw.date or ""),
        time=_normalize_time(raw.time or ""),
        clinic=raw.clinic,
        provider=raw.provider,
        title=raw.title,
        notes=raw.notes,
        biomarkers=std_biomarkers,
        visit_data=visit_data,
        imaging_data=raw.imaging_data,
    )

    _apply_status(result)
    return result
