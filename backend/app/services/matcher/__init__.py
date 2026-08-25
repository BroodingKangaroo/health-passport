"""Biomarker matching package.

Behavior-preserving split of the former single-module ``matcher.py``. The
import surface is unchanged: external code (``app/api/ai.py``,
``e2e/validate_offline.py``, tests) keeps importing from
``app.services.matcher`` — only this facade knows about the submodules.

Module map:
- ``_cache``          per-thread, extraction-scoped LLM caches (shared singletons)
- ``_text``           tiny text helpers shared across modules
- ``loinc_store``     LOINC CSV loading, definition promotion, alias/multilingual tables
- ``name_matching``   name index, deterministic/fuzzy matching, percent routing
- ``llm_matching``    candidate retrieval, zero-shot LOINC guess, verify backstop
- ``units_guess``     unit translation to English + empty-unit guessing
- ``units_conversion`` conversion factors, cross-scale functions, canonical landing
- ``translation``     biomarker-name and visit-data translation (+ fallbacks)
- ``definitions``     verify_or_create / local definition copies
- ``standardize``     StandardizedBiomarker builders, status apply, fallback path
- ``pipeline``        the match_and_convert orchestrator
"""

from app.services.matcher._cache import (
    _factor_cache,
    _local_cache,
    _RequestBucket,
    _scale_function_cache,
    _unit_translation_cache,
)
from app.services.matcher._text import _is_ascii
from app.services.matcher.definitions import (
    _make_local_copy,
    verify_or_create,
)
from app.services.matcher.llm_matching import (
    _VERIFY_PROMPT,
    LLM_CANDIDATE_COUNT,
    ZERO_SHOT_PROMPT,
    _candidates_for,
    _common_biomarker_guide,
    _guess_is_consistent,
    _llm_zero_shot_batch,
    _resolve_correction,
    _verify_and_correct,
)
from app.services.matcher.loinc_store import (
    _QUALIFIER_RE,
    LOINC_CSV,
    _load_loinc_aliases,
    _load_loinc_rows,
    _load_multilingual_lookup,
    _multilingual_code,
    _promote_loinc_from_csv,
)
from app.services.matcher.name_matching import (
    _PERCENT_UNITS,
    _PUNCT_RE,
    FUZZY_ACCEPT_SCORE,
    FUZZY_RATIO_MIN,
    MIN_FUZZY_KEY_LEN,
    _definition_rank,
    _fraction_variant,
    _is_fraction_def,
    _is_percent_unit,
    _normalize_name,
    _strip_trailing_punct,
    build_name_index,
    deterministic_match,
    fuzzy_match,
    is_grounded,
)
from app.services.matcher.pipeline import match_and_convert
from app.services.matcher.standardize import (
    _apply_status,
    _build_standardized_from_def,
    _build_standardized_local,
    _fallback_standardize,
    _prefer_comma_pct,
)
from app.services.matcher.translation import (
    _TRANSLATE_PROMPT,
    TRANSLATE_PROMPT,
    _fallback_translate,
    _llm_translate_visit_data,
    _normalize_date,
    _normalize_time,
    _translate_names_batch,
    _tx,
)
from app.services.matcher.units_conversion import (
    _SCALE_FUNCTION_PROMPT,
    CONVERSION_FACTOR_PROMPT,
    _apply_scale_function,
    _convert_to_canonical,
    _llm_conversion_factor,
    _llm_scale_function,
    _units_match,
    convert_units,
)
from app.services.matcher.units_guess import (
    _UNIT_TRANSLATE_PROMPT,
    _guess_unit,
    _heuristic_unit_translation,
    _translate_units_batch,
    _translated_unit,
)

__all__ = [
    "CONVERSION_FACTOR_PROMPT",
    "FUZZY_ACCEPT_SCORE",
    "FUZZY_RATIO_MIN",
    "LLM_CANDIDATE_COUNT",
    "LOINC_CSV",
    "MIN_FUZZY_KEY_LEN",
    "TRANSLATE_PROMPT",
    "ZERO_SHOT_PROMPT",
    "_PERCENT_UNITS",
    "_PUNCT_RE",
    "_QUALIFIER_RE",
    "_SCALE_FUNCTION_PROMPT",
    "_TRANSLATE_PROMPT",
    "_UNIT_TRANSLATE_PROMPT",
    "_VERIFY_PROMPT",
    "_RequestBucket",
    "_apply_scale_function",
    "_apply_status",
    "_build_standardized_from_def",
    "_build_standardized_local",
    "_candidates_for",
    "_common_biomarker_guide",
    "_convert_to_canonical",
    "_definition_rank",
    "_factor_cache",
    "_fallback_standardize",
    "_fallback_translate",
    "_fraction_variant",
    "_guess_is_consistent",
    "_guess_unit",
    "_heuristic_unit_translation",
    "_is_ascii",
    "_is_fraction_def",
    "_is_percent_unit",
    "_llm_conversion_factor",
    "_llm_scale_function",
    "_llm_translate_visit_data",
    "_llm_zero_shot_batch",
    "_load_loinc_aliases",
    "_load_loinc_rows",
    "_load_multilingual_lookup",
    "_local_cache",
    "_make_local_copy",
    "_multilingual_code",
    "_normalize_date",
    "_normalize_name",
    "_normalize_time",
    "_prefer_comma_pct",
    "_promote_loinc_from_csv",
    "_resolve_correction",
    "_scale_function_cache",
    "_strip_trailing_punct",
    "_translate_names_batch",
    "_translate_units_batch",
    "_translated_unit",
    "_tx",
    "_unit_translation_cache",
    "_units_match",
    "_verify_and_correct",
    "build_name_index",
    "convert_units",
    "deterministic_match",
    "fuzzy_match",
    "is_grounded",
    "match_and_convert",
    "verify_or_create",
]
