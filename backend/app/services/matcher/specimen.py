"""Specimen (biomaterial) awareness for matching.

A generic analyte spelling ("Глюкоза", "Белок", "Гемоглобин") exists in blood,
urine and feces variants with different LOINC codes. The extractor reports the
document's specimen (plus per-row overrides for reports that mix materials);
the matcher uses it to resolve specimen-correct targets and to keep local
definitions of different specimens apart on the timeline.
"""

BLOOD = "blood"
URINE = "urine"
FECES = "feces"
OTHER = "other"

# Specimens that qualify local definition names/ids ("Protein (urine)") so a
# urine local can never unify with its blood namesake. Blood is the default
# majority and stays unqualified; "other" is a low-confidence catch-all and
# must NOT change identity (a misclassified blood doc would fork every local).
QUALIFIED_SPECIMENS = (URINE, FECES)

_SPECIMEN_ALIASES = {
    "blood": BLOOD,
    "serum": BLOOD,
    "plasma": BLOOD,
    "whole blood": BLOOD,
    "кровь": BLOOD,
    "сыворотка": BLOOD,
    "плазма": BLOOD,
    "urine": URINE,
    "urinalysis": URINE,
    "моча": URINE,
    "мочи": URINE,
    "feces": FECES,
    "faeces": FECES,
    "stool": FECES,
    "кал": FECES,
    "кала": FECES,
    "other": OTHER,
}

# Matched before longer aliases so "whole blood" wins over "blood".
_ALIASES_BY_LENGTH = sorted(_SPECIMEN_ALIASES, key=len, reverse=True)


def normalize_specimen(value: str) -> str:
    """Map a free-form specimen string to a controlled value.

    Returns one of BLOOD, URINE, FECES, OTHER, or "" (unknown). Tolerates
    phrases like "urine (midstream)" and localized words.
    """
    text = (value or "").strip().lower()
    if not text:
        return ""
    if text in _SPECIMEN_ALIASES:
        return _SPECIMEN_ALIASES[text]
    for alias in _ALIASES_BY_LENGTH:
        if alias in text:
            return _SPECIMEN_ALIASES[alias]
    return ""


def specimen_for_reading(doc_specimen: str, row_specimen: str) -> str:
    """Effective specimen for one row: its own override, else the document's."""
    return normalize_specimen(row_specimen) or normalize_specimen(doc_specimen)


def qualify_specimen_name(name: str, specimen: str) -> str:
    """Append a specimen qualifier to a local display name when needed.

    "Protein" + urine -> "Protein (urine)"; blood/other/unknown pass through.
    The qualifier is part of the local definition's name and id hash, so the
    same analyte in two specimens never compares or unifies across them.
    """
    if specimen not in QUALIFIED_SPECIMENS:
        return name
    suffix = f" ({specimen})"
    if (name or "").lower().endswith(suffix):
        return name
    return f"{name}{suffix}"
