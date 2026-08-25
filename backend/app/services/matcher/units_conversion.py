"""Unit conversion: deterministic + LLM factors, cross-scale (log↔linear)
scale functions, and canonical-unit landing."""

import json
import logging
import math
from typing import Optional, Union

from mistralai import Mistral

from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.schemas.ai import ConversionFactor, RawBiomarker, ScaleFunction
from app.services import converters
from app.services.matcher._cache import (
    _factor_cache,
    _local_cache,
    _scale_function_cache,
)
from app.services.matcher.units_guess import _translated_unit

logger = logging.getLogger(__name__)

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
    cache = _local_cache(_factor_cache)
    if key in cache:
        return cache[key]
    if client is None:
        cache[key] = None
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
        cf = ConversionFactor(**json.loads(content)) if isinstance(content, str) else content
        factor = cf.factor if cf.convertible else None
    except Exception as e:
        logger.warning("LLM conversion factor failed (%s %s->%s): %s", analyte, from_unit, to_unit, e)
        factor = None
    cache[key] = factor
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

    Pure log↔linear scale changes are handled deterministically without the
    LLM.  The LLM is only consulted for ``factor:<N>`` (same-kind linear
    conversions where the units differ, e.g. "copies/mL" → "copies/g").

    Cached for the request. Returns "" on failure or when it can't decide
    (the caller is expected to surface that as ``needs_review``).
    """
    key = (
        (analyte or "").lower(),
        (from_unit or "").lower(),
        (to_unit or "").lower(),
        from_kind,
        to_kind,
    )
    cache = _local_cache(_scale_function_cache)
    if key in cache:
        return cache[key]

    # Deterministic cross-scale conversions — no LLM needed.
    if from_kind == "log10" and to_kind == "linear":
        cache[key] = "10^x"
        return "10^x"
    if from_kind == "linear" and to_kind == "log10":
        cache[key] = "log10"
        return "log10"
    if from_kind == "ln" and to_kind == "linear":
        cache[key] = "exp(x)"
        return "exp(x)"
    if from_kind == "linear" and to_kind == "ln":
        cache[key] = "ln"
        return "ln"

    if client is None:
        cache[key] = ""
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
        sf = ScaleFunction(**json.loads(content)) if isinstance(content, str) else content
        fn = (sf.function or "").strip()
    except Exception as e:
        logger.warning(
            "LLM scale function failed (%s %s/%s -> %s/%s): %s",
            analyte, from_kind, from_unit, to_kind, to_unit, e,
        )
        fn = ""
    cache[key] = fn
    return fn


def _apply_scale_function(value: float, function: str) -> Optional[float]:
    """Apply a scale function string to a numeric value. Returns None when
    the function string is empty or malformed (caller treats as failure)."""
    if not function or not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        v = float(value)
        # Absent / below-detection (0.0) must stay 0 under log→linear
        # conversion. 10^0 = 1 and e^0 = 1 would falsely mark the analyte
        # as present.
        if v == 0.0 and function in ("10^x", "exp(x)"):
            return 0.0
        if function == "10^x":
            return 10.0 ** v
        if function == "log10":
            return None if v <= 0 else math.log10(v)
        if function == "exp(x)":
            return math.exp(v)
        if function == "ln":
            return None if v <= 0 else math.log(v)
        if function.startswith("factor:"):
            return v * float(function.split(":", 1)[1])
        # Unknown function (empty / junk) → caller should treat as failure.
        return None
    except (ValueError, OverflowError):
        return None


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
    canon_unit = defn.canonical_unit or None
    canon_kind = defn.canonical_kind or "linear"
    raw_translation = _translated_unit(raw_bm.unit, raw_bm.standard_name_en or raw_bm.name, raw_bm.category)
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
