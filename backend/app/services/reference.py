"""Single home for reference parsing, value parsing, and status computation.

Replaces the previous fragmented model (``range_min``/``range_max`` columns +
a ``status`` string computed in three different places) with one structured
``reference`` object whose ``kind`` field is the sole discriminator between a
numeric (interval) result and a qualitative (text) result.

Qualitative text values are normalised to canonical English enum values so that
comparisons are deterministic and the UI never leaks raw Russian/foreign text.
"""

import math
import re
from typing import Any, Optional, Union

Number = Union[int, float]

_NUM_RE = re.compile(r"-?\d+(?:[.,]\d+)?")
_LT_RE = re.compile(r"<\s*([\d.]+)")
_GT_RE = re.compile(r">\s*([\d.]+)")
_R_RANGE_RE = re.compile(r"([\d.]+)\s*[\u2013-]\s*([\d.]+)")
# A single numeric token may be:
#   - ``N*10^K``  (e.g. ``9*10^7`` → 9e7)   — scientific notation
#   - ``N×10^K`` / ``N·10^K`` / ``Nx10^K``   — same, with different multipliers
#   - ``N^K``     (e.g. ``10^10`` → 1e10)  — mathematical exponentiation
#   - ``N,M``     (e.g. ``8,75``  → 8.75)  — Russian decimal comma
#   - ``N``       (plain number, plain ``,`` or ``.`` decimal)
# We try these in priority order in ``_parse_sci_value``; the regexes below
# are the building blocks.
_SCI_MULT_RE = re.compile(
    r"^\s*(\d+(?:[.,]\d+)?)\s*[*×·x]\s*10\s*\^?\s*(\d+)\s*$"
)
_POW_RE = re.compile(
    r"^\s*(\d+(?:[.,]\d+)?)\s*\^\s*(\d+)\s*$"
)
_COMMA_RE = re.compile(r"^\s*(\d+),(\d+)\s*$")
# "less than" / "more than" prefix: "менее N", "более N", "не более N",
# "не менее N", "< N", "> N", "<= N", ">= N", "≤ N", "≥ N". The numeric
# payload may itself be in any of the scientific/power/comma/plain forms.
_PREFIX_NUM_RE = re.compile(
    r"^\s*(?:менее|более|не\s+более|не\s+менее|<\s*=|>\s*=|<\s*|>\s*|≤|≥)\s*(.+?)\s*$",
    re.IGNORECASE,
)
# Range form: splits on en/em/hyphen dash and parses each side as a numeric
# token. Surrounding spaces are tolerated. Groups: (low, high).
_SCI_RANGE_RE = re.compile(
    r"^\s*(.+?)\s*[\u2013\u2014\-]\s*(.+?)\s*$"
)
# "допустимо любое количество" / "любое количество" — no-bound interval
# (any value is acceptable for this analyte).
_ANY_AMOUNT_RE = re.compile(
    r"^\s*(?:допустимо\s+)?любое\s+количество\s*$", re.IGNORECASE
)

# ---------------------------------------------------------------------------
# Qualitative value normalisation ─ maps raw (Russian/English) text to a
# canonical English enum value that is displayed in the UI and used for
# comparison.  Terms that do not appear below are returned verbatim.
# ---------------------------------------------------------------------------

_QUAL_MAP: dict[str, str] = {t.lower().strip(): c for t, c in (
    ("absent",             "Absent"),
    ("not detected",       "Not detected"),
    ("negative",           "Negative"),
    ("normal",             "Normal"),
    ("present",            "Present"),
    ("detected",           "Detected"),
    ("positive",           "Positive"),
    ("abnormal",           "Abnormal"),
    # Russian
    ("отсутствуют",        "Absent"),
    ("отсутствует",        "Absent"),
    ("не выявлена",        "Not detected"),
    ("не выявлено",        "Not detected"),
    ("не выявл",           "Not detected"),
    ("не обнаружена",      "Not detected"),
    ("не обнаружено",      "Not detected"),
    ("не обнар",           "Not detected"),
    ("не обнаруж",         "Not detected"),
    ("отрицательно",       "Negative"),
    ("отрицательный",      "Negative"),
    ("отрицат.",           "Negative"),
    ("отрицат",            "Negative"),
    ("отриц.",             "Negative"),
    ("присутствуют",       "Present"),
    ("обнаружена",         "Detected"),
    ("обнаружено",         "Detected"),
    ("выявлена",           "Detected"),
    ("выявлено",           "Detected"),
    ("положительно",       "Positive"),
    ("положительный",      "Positive"),
    ("нет",                "Absent"),
    ("да",                 "Present"),
    # Legacy numeric-only artefacts that labs sometimes print as a "range"
    ("0",                  "Absent"),
)}
"""
Map lowercase normalised raw text → canonical English qualitative value.
Qualitative values are an enum from the canonical set:

    Absent, Not detected, Negative, Normal, Present, Detected, Positive, Abnormal
"""

# Categorisation of canonical values for numeric-to-qualitative bridging:
_ABSENT_CANONICAL = frozenset({"Absent", "Not detected", "Negative", "Normal"})
_PRESENT_CANONICAL = frozenset({"Present", "Detected", "Positive", "Abnormal"})
_ABSENT_CANONICAL_LOWER = frozenset(v.lower() for v in _ABSENT_CANONICAL)
_PRESENT_CANONICAL_LOWER = frozenset(v.lower() for v in _PRESENT_CANONICAL)

# List of canonical qualitative values; exposed for code that builds dropdowns.
QUALITATIVE_VALUES = [
    "Negative", "Positive", "Detected", "Not detected",
    "Absent", "Present", "Normal", "Abnormal",
]


def normalize_qual(text: Any) -> Optional[str]:
    """Convert a raw qualitative result / reference text to its canonical English
    enum value.  Returns ``None`` for empty input.  Numeric values are
    converted: 0 → Absent, anything else → Present."""
    if text is None:
        return None
    # Numeric ─ bridge via the presence / absence category.
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        val = float(text)
        if val == 0:
            return "Absent"
        return "Present" if val > 0 else None
    s = str(text).strip()
    if not s:
        return None
    return _QUAL_MAP.get(s.lower(), s)


def _parse_numeric_token(text: str) -> Optional[float]:
    """Parse a single numeric token (one side of a range, or a bare value)
    into a float. Accepts plain numbers, Russian comma decimals, scientific
    notation (``9*10^7``, ``9×10^7``, ``9·10^7``, ``9x10^3``), and
    mathematical exponentiation (``10^10`` → 1e10). Returns ``None`` when
    the input cannot be turned into a finite number.
    """
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    # Scientific notation: N × 10^K → N * 10^K
    m = _SCI_MULT_RE.match(s)
    if m:
        try:
            return float(m.group(1).replace(',', '.')) * (10 ** int(m.group(2)))
        except (TypeError, ValueError):
            return None
    # Mathematical exponentiation: N^K → N ** K (so "10^10" = 1e10)
    m = _POW_RE.match(s)
    if m:
        try:
            return float(m.group(1).replace(',', '.')) ** int(m.group(2))
        except (TypeError, ValueError):
            return None
    # Russian decimal comma: "8,75"
    m = _COMMA_RE.match(s)
    if m:
        try:
            return float(f"{m.group(1)}.{m.group(2)}")
        except (TypeError, ValueError):
            return None
    # Plain number (allows "," decimal as a courtesy fallback)
    try:
        val = float(s.replace(',', '.'))
    except ValueError:
        return None
    return val if math.isfinite(val) else None


def parse_reference(text: Optional[str]) -> Optional[dict]:
    """Parse a free-text reference string (as printed by a lab) into a
    structured reference dict, or ``None`` when empty.

    Returns a dict whose ``kind`` is either ``"interval"`` (numeric range,
    with optional one-sided bound or no bounds) or ``"qualitative"`` (text
    expected value, normalised to canonical English so the UI never leaks
    raw Russian / foreign labels).

    Recognised interval forms (in priority order):
      - ``< N`` / ``> N`` (and ``<= N`` / ``>= N`` / ``≤ N`` / ``≥ N``)
      - ``менее N`` / ``более N`` / ``не более N`` / ``не менее N``
      - ``N1 - N2`` (also ``N1^N2 - N3^N4``, ``N1,N2 - N3,N4``, en/em dash)
      - ``допустимо любое количество`` / ``любое количество`` → unbounded
    """
    if not text:
        return None
    s = text.strip()
    if not s:
        return None

    lt = _LT_RE.match(s)
    if lt:
        try:
            return {"kind": "interval", "low": None, "high": float(lt.group(1))}
        except ValueError:
            pass
    gt = _GT_RE.match(s)
    if gt:
        try:
            return {"kind": "interval", "low": float(gt.group(1)), "high": None}
        except ValueError:
            pass

    # Russian "не более N" / "не менее N" / "менее N" / "более N" → interval.
    pm = _PREFIX_NUM_RE.match(s)
    if pm:
        val = _parse_numeric_token(pm.group(1))
        if val is not None:
            op = s.lower()
            if op.startswith(("менее", "не более")) or op.lstrip().startswith("<") or op.lstrip().startswith("≤"):
                return {"kind": "interval", "low": None, "high": val}
            return {"kind": "interval", "low": val, "high": None}

    # "допустимо любое количество" → any value is acceptable (no bounds).
    if _ANY_AMOUNT_RE.match(s):
        return {"kind": "interval", "low": None, "high": None}

    # Numeric range (possibly with scientific notation / Russian comma).
    rng = _SCI_RANGE_RE.match(s)
    if rng:
        low = _parse_numeric_token(rng.group(1))
        high = _parse_numeric_token(rng.group(2))
        if low is not None and high is not None:
            return {"kind": "interval", "low": low, "high": high}

    return {"kind": "qualitative", "expected": normalize_qual(s)}


def parse_value(text: Any) -> Union[float, str, None]:
    """Parse a raw result string into a numeric value or a qualitative string.

    The caller is responsible for normalising qualitative strings via
    ``normalize_qual`` before storage.  Non-finite numeric forms ("nan",
    "inf", overflow-sized numbers) are rejected and yield ``None`` — a NaN
    value would poison status computation and serialise as invalid JSON.
    """
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    # 1. Plain float (handles "5.5", "11.10", "1.0", "1", "0.7" etc.)
    try:
        val = float(s)
    except ValueError:
        pass
    else:
        return val if math.isfinite(val) else None
    # 2. Scientific notation: "9*10^7", "9×10^7", "9·10^7", "9x10^3" → N*10^K
    m = _SCI_MULT_RE.match(s)
    if m:
        v = _parse_numeric_token(s)
        if v is not None:
            return v
    # 3. Mathematical exponentiation: "10^10" → 10^10 = 1e10
    m = _POW_RE.match(s)
    if m:
        v = _parse_numeric_token(s)
        if v is not None:
            return v
    # 4. Russian decimal comma: "8,75"
    m = _COMMA_RE.match(s)
    if m:
        try:
            return float(f"{m.group(1)}.{m.group(2)}")
        except ValueError:
            pass
    # 5. "less than N" / "more than N" → threshold (caller treats the value
    #    as the boundary; the "less than" semantic is carried by the raw
    #    string and the upper-bound reference interval).
    m = _PREFIX_NUM_RE.match(s)
    if m:
        v = _parse_numeric_token(m.group(1))
        if v is not None:
            return v
    # 6. Extract the first number from the string (fallback for any other
    #    noisy numeric form, e.g. "11.10 мг/дл" → 11.1). Comma is also
    #    accepted as a decimal separator here.
    m = _NUM_RE.search(s)
    if m:
        try:
            val = float(m.group(0).replace(',', '.'))
        except ValueError:
            pass
        else:
            if math.isfinite(val):
                return val
    return s


def _qual_expected_to_interval(expected: Optional[str]) -> Optional[dict]:
    """Convert a qualitative expected text to an interval when it maps to a
    known absence/presence term.  ``None`` when unrecognised."""
    if not expected:
        return None
    key = expected.lower().strip()
    if key in _ABSENT_CANONICAL_LOWER:
        return {"kind": "interval", "low": None, "high": 0}
    if key in _PRESENT_CANONICAL_LOWER:
        return {"kind": "interval", "low": 0, "high": None}
    return None


def merge_reference(
    doc_reference: Optional[dict], defn_reference: Optional[dict], value: Any
) -> Optional[dict]:
    """Compose the *effective* reference for a reading.

    Document-first: when the lab printed its own reference range we trust it.
    Otherwise a qualitative (string) value forces a qualitative reference.

    A numeric value paired with a qualitative reference (e.g. Absent) is
    bridged to an interval ({low:null, high:0}) so the biomarker stays
    quantitative.
    """
    if doc_reference is not None:
        return _bridge_qual_ref(doc_reference, value)
    if isinstance(value, str):
        return {"kind": "qualitative"}
    ref = _copy_reference(defn_reference)
    return _bridge_qual_ref(ref, value) if ref else None


def _bridge_qual_ref(ref: dict, value: Any) -> dict:
    """When `value` is numeric and `ref` is qualitative with a known
    expected term, convert to an interval.  Otherwise return `ref` unchanged."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return ref
    if isinstance(ref, dict) and ref.get("kind") == "qualitative":
        expected = ref.get("expected")
        if expected:
            interval = _qual_expected_to_interval(expected)
            if interval is not None:
                return interval
    return ref


def _copy_reference(ref: Optional[dict]) -> Optional[dict]:
    if ref is None:
        return None
    if isinstance(ref, dict) and "kind" in ref:
        return dict(ref)
    return ref


def _qual_status(value: Any, expected: str) -> str:
    """Normal / abnormal for a qualitative reference.

    1. Normalise the value string to canonical English (if textual).
    2. Compare with the already-normalised expected.
    3. For numeric values bridge via presence / absence category.
    """
    if value is None:
        return "abnormal"

    # (1) textual value ─ normalise both and compare.
    if isinstance(value, str):
        v_norm = normalize_qual(value)
        if v_norm is not None and v_norm == expected:
            return "normal"
        return "abnormal"

    # (2) numeric value ─ bridge via category.
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        num = float(value)
        if num == 0:
            return "normal" if expected in _ABSENT_CANONICAL else "abnormal"
        else:
            return "normal" if expected in _PRESENT_CANONICAL else "abnormal"

    return "abnormal"


def compute_status(value: Any, reference: Any) -> str:
    """Compute the lab status against a structured reference.

    Returns ``"low" | "normal" | "high" | "abnormal"``.
    """
    kind = _get(reference, "kind")
    if kind is None:
        return "normal"

    if kind == "interval":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return "normal"
        low = _get(reference, "low")
        high = _get(reference, "high")
        if low is not None and value < low:
            return "low"
        if high is not None and value > high:
            return "high"
        return "normal"

    if kind == "qualitative":
        expected = _get(reference, "expected")
        if not expected:
            return "normal"
        return _qual_status(value, expected)

    return "normal"


def _get(ref: Any, key: str, default: Any = None) -> Any:
    if ref is None:
        return default
    if isinstance(ref, dict):
        return ref.get(key, default)
    return getattr(ref, key, default)
