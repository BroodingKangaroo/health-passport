"""Band-aware document reference parsing (matcher-side wrapper).

Some labs print segmented reference texts that ``reference.parse_reference``
cannot reduce to a single interval:

    "желательный уровень холестерина <5.17, пограничный 5.17-6.18, ..."
    "Уровни с учетом риска ...: <2.59 - оптимальный, ..."
    "до 0.9 - отрицательный, от 0.9 до 1.0 - серая зона, от 1.0 - ..."

For a NUMERIC reading the applicable band is the normal/optimal one, which is
the first bound printed. Age/sex-banded texts are deliberately left to the
original parser: picking a band without the patient's demographics would
encode a wrong cutoff (KNOWN_ISSUES: stratified bands need patient sex/age),
so those keep their current (unknown) reference until a demographics-aware
feature lands.

Only used for readings with a numeric value; qualitative screens keep the
original parse.
"""

import re
from typing import Any, Optional

from app.services.reference import parse_reference

_AGE_SEX_RE = re.compile(
    r"лет|год|месяц|недел|мужчин|женщин|мальчик|девочк|дети|детей|ребен|"
    r"взросл|новорожд|пациент",
    re.IGNORECASE,
)
_BOUND_HIGH_RE = re.compile(r"(?:<\s*|≤\s*|до\s+|не более\s+)(\d+(?:[.,]\d+)?)")
_BOUND_LOW_RE = re.compile(r"(?:>\s*|≥\s*|более\s+|выше\s+)(\d+(?:[.,]\d+)?)")
_RANGE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)")


def _num(token: str) -> float:
    return float(token.replace(",", "."))


def parse_reference_for_value(text: Optional[str], value: Any) -> Optional[dict]:
    """``parse_reference`` plus a conservative first-band fallback.

    Applied only when the original parse did not produce an interval AND the
    reading's value is numeric AND the text carries no age/sex qualifier.
    """
    parsed = parse_reference(text)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return parsed
    if isinstance(parsed, dict) and parsed.get("kind") == "interval":
        return parsed
    if not text or _AGE_SEX_RE.search(text):
        return parsed
    match = _BOUND_HIGH_RE.search(text)
    if match:
        return {"kind": "interval", "low": None, "high": _num(match.group(1))}
    match = _RANGE_RE.search(text)
    if match:
        low, high = _num(match.group(1)), _num(match.group(2))
        if low <= high:
            return {"kind": "interval", "low": low, "high": high}
    match = _BOUND_LOW_RE.search(text)
    if match:
        return {"kind": "interval", "low": _num(match.group(1)), "high": None}
    return parsed
