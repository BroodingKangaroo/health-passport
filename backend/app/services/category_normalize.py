"""Normalize a biomarker's raw category / panel heading into a stable,
human-readable English panel name.

Two kinds of category strings reach the system:

* LOINC-matched global definitions carry the raw LOINC ``CLASS`` code
  (e.g. ``"HEM/BC"``, ``"CHEM"``). These render as cryptic headings even on
  English documents.
* Unmatched (local) definitions carry the source document's own panel heading
  (possibly in a non-English language). We keep that verbatim — canonicalizing
  a foreign heading into English would require an LLM pass, which the matcher
  must not perform for determinism.

The normalization precedence is:

1. A curated per-LOINC-code panel override. This handles analytes whose CLASS
   is too coarse to map to one panel (``CLASS=CHEM`` spans liver / metabolic /
   lipid / immunology), so a specific code lands in the right panel instead of
   the catch-all ``"Chemistry"``.
2. A LOINC CLASS -> friendly panel map for the unambiguous codes.
3. A fallback that keeps the original heading (whitespace-collapsed) for
   local / source-derived categories.
"""

import re
from typing import Optional

# Curated per-LOINC-code panel. Wins over the coarse CLASS code. Covers the
# common panels so e.g. a CHEM analyte resolves to "Liver Function" /
# "Lipid Panel" / "Comprehensive Metabolic Panel" rather than "Chemistry".
PANEL_BY_LOINC: dict[str, str] = {
    # Complete Blood Count
    "6690-2": "Complete Blood Count",
    "789-8": "Complete Blood Count",
    "718-7": "Complete Blood Count",
    "4544-3": "Complete Blood Count",
    "777-3": "Complete Blood Count",
    # Comprehensive Metabolic Panel
    "2345-7": "Comprehensive Metabolic Panel",
    "3094-0": "Comprehensive Metabolic Panel",
    "2160-0": "Comprehensive Metabolic Panel",
    # Lipid Panel
    "2089-1": "Lipid Panel",
    "2085-9": "Lipid Panel",
    "2571-8": "Lipid Panel",
    "2093-3": "Lipid Panel",
    # Liver Function
    "1742-6": "Liver Function",
    "1920-8": "Liver Function",
    "1975-2": "Liver Function",
    "2324-2": "Liver Function",
    # Iron Panel
    "2498-4": "Iron Panel",
    "2276-4": "Iron Panel",
    "35234-4": "Iron Panel",
    # Thyroid Panel
    "3016-3": "Thyroid Panel",
    "30252-6": "Thyroid Panel",
    # Vitamins
    "2132-9": "Vitamins",
    "39492-1": "Vitamins",
    # Immunology / other chemistry
    "19113-0": "Immunology",
    "3084-1": "Metabolic",
    "2885-2": "Chemistry",
}

# Unambiguous LOINC CLASS codes -> friendly panel name.
LOINC_CLASS_TO_PANEL: dict[str, str] = {
    "HEM/BC": "Complete Blood Count",
    "HEM": "Hematology",
    "COAG": "Coagulation",
    "CHEM": "Chemistry",
    "MICRO": "Microbiology",
    "SERO": "Serology",
    "URI": "Urinalysis",
    "ENDOC": "Endocrinology",
    "CARD": "Cardiac",
    "TUMR": "Tumor Markers",
    "FERT": "Fertility",
    "NUTR": "Nutrition",
    "DRG": "Therapeutic Drug Monitoring",
}

# A raw CLASS code is short, all-caps Latin, optionally slash-separated.
_CLASS_RE = re.compile(r"^[A-Z]+(?:/[A-Z]+)*$")


def _collapse_ws(value: str) -> str:
    return " ".join((value or "").split()).strip()


def normalize_category(raw_category: str, loinc_code: Optional[str] = None) -> str:
    """Return a normalized panel name for ``raw_category``.

    ``loinc_code`` (when known) takes precedence via :data:`PANEL_BY_LOINC`,
    so a coarse CLASS code is refined to the correct panel for that analyte.
    """
    raw = _collapse_ws(raw_category)
    if not raw:
        return "General"
    if loinc_code:
        panel = PANEL_BY_LOINC.get(str(loinc_code))
        if panel:
            return panel
    if _CLASS_RE.match(raw):
        return LOINC_CLASS_TO_PANEL.get(raw, raw)
    # Source-derived heading (often a foreign-language panel title): keep it.
    return raw
