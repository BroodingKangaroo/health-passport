"""Hybrid unit conversion for lab biomarker values.

Strategy (most deterministic first):
  1. Identity — units already match.
  2. Dimensional — same physical dimension (e.g. g/L -> mg/dL) via `pint`.
  3. Molar/mass — mg/dL <-> mmol/L using a per-analyte molecular weight.

When none of these apply the caller can fall back to an LLM-supplied
conversion factor and apply it deterministically (see `apply_factor`).
"""

import logging
import re
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

try:
    import pint

    _UREG = pint.UnitRegistry()
    _UREG.default_format = "~"
except Exception as e:  # pragma: no cover - pint should be installed
    _UREG = None
    logger.warning("pint unavailable, dimensional conversion disabled: %s", e)


# Molecular weights (g/mol) for common blood analytes reported in both
# mass and molar units. Keyed by normalized analyte name.
MOLECULAR_WEIGHTS: dict[str, float] = {
    "glucose": 180.16,
    "cholesterol": 386.65,
    "hdl cholesterol": 386.65,
    "ldl cholesterol": 386.65,
    "hdl": 386.65,
    "ldl": 386.65,
    "triglyceride": 885.4,
    "triglycerides": 885.4,
    "creatinine": 113.12,
    "urea": 60.06,
    "uric acid": 168.11,
    "urate": 168.11,
    "bilirubin": 584.66,
    "total bilirubin": 584.66,
    "direct bilirubin": 584.66,
    "calcium": 40.08,
    "magnesium": 24.31,
    "phosphate": 94.97,
    "iron": 55.85,
    "cortisol": 362.46,
    "testosterone": 288.42,
    "albumin": 66500.0,
    "lactate": 90.08,
}


# Localized (non-English) clinical unit strings -> canonical Latin units that
# pint understands. Keyed by a lowercased, whitespace-stripped form. Cyrillic
# units are common in RU/UA lab reports and must be normalized before any
# dimensional / molar conversion is attempted.
LOCALIZED_UNIT_SYNONYMS: dict[str, str] = {
    # molar concentrations
    "ммоль/л": "mmol/L",
    "мкмоль/л": "µmol/L",
    "нмоль/л": "nmol/L",
    "пмоль/л": "pmol/L",
    "моль/л": "mol/L",
    "фмоль/л": "fmol/L",
    # mass concentrations
    "г/л": "g/L",
    "г/дл": "g/dL",
    "мг/л": "mg/L",
    "мг/дл": "mg/dL",
    "мкг/л": "ug/L",
    "мкг/дл": "ug/dL",
    "нг/л": "ng/L",
    "нг/мл": "ng/mL",
    "нг/дл": "ng/dL",
    "пг/мл": "pg/mL",
    "мкг/мл": "ug/mL",
    "мг/мл": "mg/mL",
    # enzyme activity
    "ед/л": "U/L",
    "ед/мл": "U/mL",
    "ме/л": "IU/L",
    "ме/мл": "IU/mL",
    "мед/л": "mU/L",
    "мкме/мл": "uIU/mL",
    "мкед/мл": "uU/mL",
    # cell counts
    "10*9/л": "10*9/L",
    "10*12/л": "10*12/L",
    "10^9/л": "10*9/L",
    "10^12/л": "10*12/L",
    "×10⁹/л": "10*9/L",
    "×10¹²/л": "10*12/L",
    "тыс/мкл": "10*3/uL",
    "млн/мкл": "10*6/uL",
    "кл/мкл": "/uL",
    # rates / misc
    "мм/ч": "mm/h",
    "мм/час": "mm/h",
    "пг": "pg",
    "фл": "fL",
    "мосм/кг": "mosm/kg",
    "мкмоль/сут": "µmol/d",
    "ммоль/сут": "mmol/d",
}


def normalize_unit(unit: str) -> str:
    """Translate a localized/Cyrillic unit string to its canonical Latin form.

    Returns the original (trimmed) unit when no localized synonym is known so
    callers can display something sensible. Case/space-insensitive lookup.
    """
    if not unit:
        return ""
    key = unit.strip().lower().replace(" ", "")
    if key in LOCALIZED_UNIT_SYNONYMS:
        return LOCALIZED_UNIT_SYNONYMS[key]
    return unit.strip()


def _norm_unit(unit: str) -> str:
    """Normalize a clinical unit string for comparison."""
    if not unit:
        return ""
    # Map localized (e.g. Cyrillic) units to canonical Latin first.
    unit = normalize_unit(unit)
    u = unit.strip().replace("µ", "u").replace("μ", "u").lower()
    u = re.sub(r"\bmcg", "ug", u)
    # International units are equivalent to plain activity units (IU/L == U/L).
    u = re.sub(r"(?<![a-z])iu", "u", u)
    u = u.replace(" ", "")
    return u


def _dimensional_factor(from_unit: str, to_unit: str) -> Optional[float]:
    """Conversion factor for same-dimension mass/volume units via pint."""
    if _UREG is None:
        return None
    try:
        q = _UREG.Quantity(1.0, from_unit)
        converted = q.to(to_unit)
        return float(converted.magnitude)
    except Exception:
        return None


def _molar_mass_factor(from_unit: str, to_unit: str, mw: Optional[float]) -> Optional[float]:
    """Factor for mass/volume <-> molar/volume using molecular weight (g/mol).

    Handles the common clinical pair mg/dL <-> mmol/L (and g/L, umol/L, etc.).
    """
    if not mw or mw <= 0 or _UREG is None:
        return None

    # Detect molar vs mass on each side by checking against 'mol'.
    def _is_molar(u: str) -> bool:
        try:
            return _UREG.Quantity(1.0, u).check("[substance] / [length] ** 3") or "mol" in u.lower()
        except Exception:
            return "mol" in u.lower()

    from_molar = _is_molar(from_unit)
    to_molar = _is_molar(to_unit)
    if from_molar == to_molar:
        return None  # both molar or both mass -> not a molar/mass conversion

    try:
        if from_molar and not to_molar:
            # amount/volume -> mass/volume:  mass = amount * MW
            base = _UREG.Quantity(1.0, from_unit).to("mol/liter").magnitude
            grams_per_liter = base * mw
            return float(_UREG.Quantity(grams_per_liter, "g/liter").to(to_unit).magnitude)
        else:
            # mass/volume -> amount/volume: amount = mass / MW
            grams_per_liter = _UREG.Quantity(1.0, from_unit).to("g/liter").magnitude
            mol_per_liter = grams_per_liter / mw
            return float(_UREG.Quantity(mol_per_liter, "mol/liter").to(to_unit).magnitude)
    except Exception as e:
        logger.debug("molar/mass conversion failed %s->%s: %s", from_unit, to_unit, e)
        return None


def conversion_factor(
    from_unit: str,
    to_unit: str,
    analyte_name: str = "",
    mw: Optional[float] = None,
) -> Tuple[Optional[float], str]:
    """Return (factor, method). value_in_target = value * factor.

    method is one of: 'identity', 'dimensional', 'molar_mass', 'none'.
    """
    # Canonicalize localized (e.g. Cyrillic) units so pint can parse them.
    from_canon = normalize_unit(from_unit)
    to_canon = normalize_unit(to_unit)

    fn = _norm_unit(from_unit)
    tn = _norm_unit(to_unit)

    if not fn or not tn:
        return 1.0, "identity"
    if fn == tn:
        return 1.0, "identity"

    factor = _dimensional_factor(from_canon, to_canon)
    if factor is not None:
        return factor, "dimensional"

    if mw is None:
        mw = MOLECULAR_WEIGHTS.get(_norm_analyte(analyte_name))
    factor = _molar_mass_factor(from_canon, to_canon, mw)
    if factor is not None:
        return factor, "molar_mass"

    return None, "none"


def _norm_analyte(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def convert_value(
    value: float,
    from_unit: str,
    to_unit: str,
    analyte_name: str = "",
    mw: Optional[float] = None,
) -> Tuple[Optional[float], str]:
    """Convert `value` from `from_unit` to `to_unit`.

    Returns (converted_value, method). converted_value is None when no
    deterministic conversion is known (caller may consult the LLM).
    """
    factor, method = conversion_factor(from_unit, to_unit, analyte_name, mw)
    if factor is None:
        return None, method
    return round(value * factor, 4), method


def apply_factor(value: float, factor: float) -> float:
    """Apply an externally-supplied conversion factor (e.g. from the LLM)."""
    return round(value * factor, 4)
