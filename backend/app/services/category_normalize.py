"""Normalize a biomarker's raw category / panel heading into a stable,
human-readable English panel name.

Two kinds of category strings reach the system:

* LOINC-matched global definitions carry the raw LOINC ``CLASS`` code
  (e.g. ``"HEM/BC"``, ``"CHEM"``, ``"CELLMARK"``). These render as cryptic
  headings even on English documents.
* Unmatched (local) definitions carry the source document's own panel heading
  (possibly in a non-English language). A curated static map translates the
  common headings deterministically (no LLM — the matcher must stay
  deterministic); anything unknown is kept verbatim.

The normalization precedence is:

1. A curated per-LOINC-code panel override. This handles analytes whose CLASS
   is too coarse to map to one panel (``CLASS=CHEM`` spans liver / metabolic /
   lipid / immunology), so a specific code lands in the right panel instead of
   the catch-all ``"Chemistry"``.
2. Curated local sentinel codes (``local-…`` ids from the multilingual synonym
   table) pinned to their fixed panel, so deliberately-local analytes land in
   the same panel as their global siblings.
3. A LOINC CLASS -> friendly panel map for the unambiguous codes.
4. A static source-heading map for the common foreign-language panel titles
   seen in real lab PDFs.
5. A fallback that keeps the original heading (whitespace-collapsed).
"""

import re
from typing import Optional

# Extraction sometimes appends document context to a heading, e.g.
# "Секвенирование (аналитическая чувствительность 20%)". Strip parenthetical
# / trailing qualifiers before the static lookup so the known heading still
# matches deterministically.
_QUALIFIER_RE = re.compile(r"\s*\([^)]*\)\s*|\s*[;,]\s+.*$")

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

# Curated per-user local definitions (sentinel codes from
# data/multilingual_synonyms.json). Their LLM-extracted category can be empty,
# Russian ("Инфекции"), or inconsistent between runs — pin them to the same
# panel as the analyte family they belong to. The e2e паразиты_1 golden keeps
# all serology rows under one heading this way.
LOCAL_PANEL_BY_CODE: dict[str, str] = {
    "local-opisthorchis-igg": "Microbiology",
    "local-lamblia-immunoglobulins": "Microbiology",
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
    "CELLMARK": "Immunology",
}

# Common source-document panel headings (lowercased; any language) -> stable
# English panel. Deterministic — no LLM pass here. Unknown headings fall
# through to the verbatim fallback below.
SOURCE_HEADING_TO_PANEL: dict[str, str] = {
    "инфекции": "Microbiology",
    "инфекция": "Microbiology",
    "infections": "Microbiology",
    "клинический анализ крови": "Complete Blood Count",
    "исследование состава микробиоты толстого кишечника": "Microbiome",
    "микробиом": "Microbiome",
    "секвенирование": "Genetics",
}

# A raw CLASS code is short, all-caps Latin, optionally slash-separated.
_CLASS_RE = re.compile(r"^[A-Z]+(?:/[A-Z]+)*$")

# Heading-family fallbacks (substring, lowercased): extraction mangles panel
# titles in run-dependent ways (appends audience qualifiers, swaps the heading
# for a document banner), but the family token survives. Checked after the
# exact static map so curated headings keep priority.
_HEADING_FAMILY_TO_PANEL: list[tuple[str, str]] = [
    ("микробиот", "Microbiome"),
    ("микробиом", "Microbiome"),
    ("microbiom", "Microbiome"),
]


def _collapse_ws(value: str) -> str:
    return " ".join((value or "").split()).strip()


def normalize_category(raw_category: str, loinc_code: Optional[str] = None) -> str:
    """Return a normalized panel name for ``raw_category``.

    ``loinc_code`` (when known) takes precedence via :data:`PANEL_BY_LOINC`
    and :data:`LOCAL_PANEL_BY_CODE`, so a coarse CLASS code is refined to the
    correct panel for that analyte and curated local sentinels stay pinned.
    """
    raw = _collapse_ws(raw_category)
    if not raw:
        return "General"
    if loinc_code:
        code = str(loinc_code)
        panel = PANEL_BY_LOINC.get(code) or LOCAL_PANEL_BY_CODE.get(code)
        if panel:
            return panel
    if _CLASS_RE.match(raw):
        return LOINC_CLASS_TO_PANEL.get(raw, raw)
    stripped = _QUALIFIER_RE.sub(" ", raw).strip()
    for candidate in (raw, stripped):
        panel = SOURCE_HEADING_TO_PANEL.get(candidate.lower())
        if panel:
            return panel
        collapsed = " ".join(candidate.lower().split())
        panel = SOURCE_HEADING_TO_PANEL.get(collapsed)
        if panel:
            return panel
    low = raw.lower()
    for token, panel in _HEADING_FAMILY_TO_PANEL:
        if token in low:
            return panel
    return raw
