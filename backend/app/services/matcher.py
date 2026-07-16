import hashlib
import json
import logging
import os
import re
import unicodedata
from datetime import datetime
from typing import List, Optional, Tuple

from mistralai import Mistral
from rapidfuzz import fuzz, process
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.services import converters
from app.schemas.ai import (
    ConversionFactor,
    LoincGuess,
    LoincGuessBatch,
    MatchVerification,
    MatchVerificationBatch,
    RawBiomarker,
    RawMedicalRecord,
    RawVisitData,
    StandardizedMedicalRecord,
    StandardizedBiomarker,
    StandardizedVisitData,
    StandardizedPrescription,
    TranslatedText,
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


def _tx(text: str) -> TranslatedText:
    return TranslatedText(original=text, translated_en=text)


def _apply_status(result: StandardizedMedicalRecord) -> None:
    if not result.biomarkers:
        return
    for b in result.biomarkers:
        b.status = calculate_biomarker_status(
            b.standard_value, b.standard_range_min, b.standard_range_max
        )


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

def _normalize_name(name: str) -> str:
    """Normalize a biomarker name by stripping punctuation and normalizing unicode."""
    name = unicodedata.normalize('NFKC', name)
    name = _PUNCT_RE.sub('', name.strip())
    return name.lower()


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
    ranked = sorted(
        (d for d in definitions if d.scope == "global"),
        key=_definition_rank,
    )
    for d in ranked:
        if d.scope != "global":
            continue
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


def _build_standardized_from_def(
    raw_bm: RawBiomarker,
    defn: BiomarkerDefinitionModel,
    db: Optional[Session] = None,
    user_id: Optional[str] = None,
    client: Optional[Mistral] = None,
) -> StandardizedBiomarker:
    try:
        raw_float = float(re.sub(r"[^\d\.]", "", raw_bm.value))
    except (ValueError, TypeError):
        raw_float = 0.0

    # Canonicalize the document's own unit (e.g. Cyrillic "ммоль/л" -> "mmol/L").
    doc_unit = converters.normalize_unit(raw_bm.unit)
    doc_min, doc_max = _parse_range_string(raw_bm.raw_range_string)

    # Document-first: when the lab printed its own reference range, trust it and
    # keep the value in the document's own (normalized) unit. This avoids lossy
    # unit conversion and compares like-for-like, preventing false out-of-range
    # flags (e.g. a glucose of 5.5 ммоль/л against the lab's own 3.9-6.1 range).
    if doc_min is not None or doc_max is not None:
        # Keep the matched (global) definition and its identity. The document
        # range is carried on the reading itself; `scope` reflects dictionary
        # membership, NOT range provenance, so a recognized analyte must stay
        # "global" even when we display the lab's own range.
        return StandardizedBiomarker(
            raw_name=raw_bm.name,
            raw_value=raw_bm.value,
            raw_unit=raw_bm.unit,
            raw_range_string=raw_bm.raw_range_string,
            standard_name_en=defn.names.get("en", raw_bm.name),
            standard_value=raw_float,
            standard_unit=doc_unit or defn.unit,
            standard_range_min=doc_min,
            standard_range_max=doc_max,
            status="",
            category=defn.category,
            definition_id=defn.id,
            scope=defn.scope,
        )

    # No document range: fall back to the curated global range, converting the
    # value into the definition's canonical unit so the comparison is valid.
    std_value = convert_units(
        raw_float,
        raw_bm.unit,
        defn.unit,
        analyte_name=defn.names.get("en", raw_bm.name),
        loinc=defn.loinc_code,
        client=client,
    )

    return StandardizedBiomarker(
        raw_name=raw_bm.name,
        raw_value=raw_bm.value,
        raw_unit=raw_bm.unit,
        raw_range_string=raw_bm.raw_range_string,
        standard_name_en=defn.names.get("en", raw_bm.name),
        standard_value=std_value,
        standard_unit=defn.unit,
        standard_range_min=defn.range_min,
        standard_range_max=defn.range_max,
        status="",
        category=defn.category,
        definition_id=defn.id,
        scope=defn.scope,
    )


def _build_standardized_local(
    raw_bm: RawBiomarker,
    defn: BiomarkerDefinitionModel,
) -> StandardizedBiomarker:
    try:
        std_value = float(re.sub(r"[^\d\.]", "", raw_bm.value))
    except (ValueError, TypeError):
        std_value = 0.0

    return StandardizedBiomarker(
        raw_name=raw_bm.name,
        raw_value=raw_bm.value,
        raw_unit=raw_bm.unit,
        raw_range_string=raw_bm.raw_range_string,
        standard_name_en=defn.names.get("en", raw_bm.name),
        standard_value=std_value,
        standard_unit=raw_bm.unit,
        standard_range_min=defn.range_min,
        standard_range_max=defn.range_max,
        status="",
        category=defn.category or raw_bm.category or "General",
        definition_id=defn.id,
        scope=defn.scope,
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


def _fraction_variant(
    match: BiomarkerDefinitionModel, index: dict[str, BiomarkerDefinitionModel]
) -> Optional[BiomarkerDefinitionModel]:
    """If `match` is the absolute-count form, return the sibling "… %" (fraction)
    variant so a percent document unit resolves to the fraction analyte."""
    name = (match.names or {}).get("en", "")
    if not name or name.endswith("%"):
        return None
    frac_name = f"{name} %"
    frac = index.get(frac_name.lower())
    if frac is not None and frac.scope == "global":
        return frac
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


def _parse_range_string(range_str: str) -> tuple[Optional[float], Optional[float]]:
    """Parse a range string like '4.0-11.0', '< 5.0', '> 100', 'Negative' into (min, max)."""
    if not range_str:
        return None, None
    s = range_str.strip()
    # Single bound: < X or > X
    lt = re.match(r"<\s*([\d.]+)", s)
    if lt:
        return None, float(lt.group(1))
    gt = re.match(r">\s*([\d.]+)", s)
    if gt:
        return float(gt.group(1)), None
    # Range: X-Y or X – Y
    m = re.match(r"([\d.]+)\s*[–-]\s*([\d.]+)", s)
    if m:
        return float(m.group(1)), float(m.group(2))
    return None, None


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
                syns = list(defn.synonyms or [])
                if raw_name.lower() not in (s.lower() for s in syns):
                    syns.append(raw_name)
                    defn.synonyms = syns
                    db.flush()
                return defn
        for syn in (defn.synonyms or []):
            if syn and _normalize_name(syn) == raw_norm:
                syns = list(defn.synonyms or [])
                if raw_name.lower() not in (s.lower() for s in syns):
                    syns.append(raw_name)
                    defn.synonyms = syns
                    db.flush()
                return defn

    defn_id = f"local-{hashlib.md5(raw_name.lower().encode()).hexdigest()[:12]}"

    # Parse range from raw biomarker if available
    range_min = None
    range_max = None
    unit = ""
    if raw_biomarker:
        range_min, range_max = _parse_range_string(raw_biomarker.raw_range_string)
        unit = raw_biomarker.unit

    new_defn = BiomarkerDefinitionModel(
        id=defn_id,
        names={"en": raw_name},
        synonyms=[raw_name],
        category=raw_biomarker.category if raw_biomarker else "General",
        range_min=range_min,
        range_max=range_max,
        unit=unit,
        scope="local",
        user_id=user_id,
        range_source="pdf_extracted",
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
    defn_id = f"local-{hashlib.md5(raw_biomarker.name.lower().encode()).hexdigest()[:12]}"
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
        names = {"en": raw_biomarker.name}
        synonyms = [raw_biomarker.name]
        unit = raw_biomarker.unit or ""
        category = raw_biomarker.category or "General"

    if raw_biomarker.name not in synonyms:
        synonyms.append(raw_biomarker.name)

    range_min, range_max = _parse_range_string(raw_biomarker.raw_range_string)
    if range_min is None and range_max is None:
        if source is not None:
            range_min, range_max = source.range_min, source.range_max

    local = BiomarkerDefinitionModel(
        id=defn_id,
        names=names,
        synonyms=synonyms,
        category=category,
        range_min=range_min,
        range_max=range_max,
        unit=unit,
        scope="local",
        user_id=user_id,
        range_source=source.range_source if source is not None else "pdf_extracted",
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
        biomarkers=biomarkers or None,
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

    # Direct multilingual lookup (curated table) — resolves the most common
    # localized names deterministically without any LLM call.
    multilang = _load_multilingual_lookup()
    aliases = _load_loinc_aliases()

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
            # Redirect a curated code that was deduped away to its survivor.
            code = aliases.get(code, code)
            match = db.query(BiomarkerDefinitionModel).filter(
                BiomarkerDefinitionModel.loinc_code == code,
                BiomarkerDefinitionModel.scope == "global",
            ).first()
            # Promote a valid LOINC that exists in the full CSV but wasn't part
            # of the seeded subset (e.g. ESR, Hematocrit).
            if match is None:
                match = _promote_loinc_from_csv(db, code)

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
            frac = _fraction_variant(match, index)
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
    if matched_pairs and client:
        matched_pairs, rejected = _verify_and_correct(matched_pairs, index, db, client)
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
                std_biomarkers.append(_build_standardized_local(b, resolved))
    elif unmatched:
        for b in unmatched:
            resolved = verify_or_create(db, b.name, None, user_id, raw_biomarker=b, grounded=False)
            std_biomarkers.append(_build_standardized_local(b, resolved))

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
        biomarkers=std_biomarkers or None,
        visit_data=visit_data,
        imaging_data=raw.imaging_data,
    )

    _apply_status(result)
    return result
