"""Unit tests for the category normalization used by seed_loinc and matcher."""

from app.services.category_normalize import normalize_category


def test_class_code_maps_to_friendly_panel():
    # HEM/BC is an unambiguous LOINC CLASS code.
    assert normalize_category("HEM/BC") == "Complete Blood Count"
    assert normalize_category("CHEM") == "Chemistry"


def test_loinc_override_refines_coarse_class():
    # CLASS=CHEM spans many panels; the per-LOINC override picks the right one.
    assert normalize_category("CHEM", loinc_code="1742-6") == "Liver Function"
    assert normalize_category("CHEM", loinc_code="2093-3") == "Lipid Panel"
    assert normalize_category("CHEM", loinc_code="2345-7") == "Comprehensive Metabolic Panel"


def test_unknown_loinc_with_class_falls_back_to_class_map():
    # A CHEM analyte with no curated override still normalizes away from the
    # cryptic CLASS code.
    assert normalize_category("CHEM", loinc_code="9999-9") == "Chemistry"


def test_source_heading_is_preserved_verbatim():
    # Local (unmatched) definitions carry the source document's own heading,
    # often in a non-English language — it must not be mangled.
    ru = "Исследование состава микробиоты толстого кишечника"
    assert normalize_category(ru) == ru
    assert normalize_category(ru, loinc_code="1234-5") == ru


def test_whitespace_is_collapsed_and_empty_becomes_general():
    assert normalize_category("  HEM/BC  ") == "Complete Blood Count"
    assert normalize_category("") == "General"
    assert normalize_category(None) == "General"
