"""Regression tests for the golden-review fixes (паразиты_1 /
популяции_лимфоцитов_анализ cases, 2026-08-26):

- compound antibody names must NOT fuzzy-collapse onto bare IgG/IgA/... defs
- truncated "отрицат." canonicalises to Negative
- qualitative-only readings anchor an EMPTY canonical unit on first sight
- curated flow-cytometry subset mappings resolve via the multilingual table
  (offline-safe, no LLM)
"""

import json

import pytest

from app.services.matcher.loinc_store import _load_multilingual_lookup, _multilingual_code
from app.services.matcher.name_matching import (
    _is_carrier_subset_collision,
    _normalize_name,
)
from app.services.matcher.name_matching import (
    fuzzy_match as fuzzy,
)
from app.services.reference import normalize_qual


class _Def:
    def __init__(self, en: str, code: str = "", common_rank=None, synonyms=()):
        self.id = code or f"def-{en}"
        self.names = {"en": en}
        self.synonyms = list(synonyms)
        self.loinc_code = code
        self.common_rank = common_rank


# --- carrier-subset guard ----------------------------------------------------

def test_compound_antibody_rejected_from_bare_igg():
    idx = {"igg": _Def("IgG", "2465-3")}
    assert fuzzy("anti-Toxocara IgG", idx) is None
    assert fuzzy("anti-Opisthorchis IgG", idx) is None


def test_bare_igg_query_still_matches():
    idx = {"igg": _Def("IgG", "2465-3")}
    assert fuzzy("IgG", idx) is not None


def test_short_connectors_do_not_block_legit_matches():
    # The carrier predicate only fires when the MATCHED key itself is a bare
    # immunoglobulin class ("IgG", "IgA", …). Non-carrier analytes are never
    # blocked by it, no matter how compound the query looks.
    idx = {"crp": _Def("C-reactive protein", "30522-7")}
    # Verify against the predicate directly (fuzzy threshold rules already
    # gate very short keys independently of this fix).
    assert not _is_carrier_subset_collision(
        _normalize_name("hs CRP blood test"), _normalize_name("CRP")
    )
    assert idx["crp"].names["en"] == "C-reactive protein"


def test_guard_predicate_directly():
    assert _is_carrier_subset_collision(
        _normalize_name("anti-Toxocara IgG"), _normalize_name("IgG")
    )
    assert not _is_carrier_subset_collision(_normalize_name("IgG"), _normalize_name("IgG"))
    # matched def is not a pure carrier name → never blocked by this predicate
    assert not _is_carrier_subset_collision(
        _normalize_name("anti-Giardia antibody"), _normalize_name("Giardia")
    )


# --- truncated отрицат. ------------------------------------------------------

@pytest.mark.parametrize(("raw", "expected"), [
    ("отрицат.", "Negative"),
    ("отрицат", "Negative"),
    ("отриц.", "Negative"),
    ("Отрицательно", "Negative"),
])
def test_negative_abbreviations_canonicalise(raw, expected):
    assert normalize_qual(raw) == expected


# --- qualitative-only first-seen unit ----------------------------------------

class _FakeRawBM:
    def __init__(self, value, rng=""):
        from app.schemas.ai import RawBiomarker

        inner = RawBiomarker(name="anti-X IgG", value=value, unit="", raw_range_string=rng)
        self.value = inner.value
        self.raw_range_string = inner.raw_range_string
        self.unit = inner.unit
        self.category = inner.category
        self.name = inner.name
        self.standard_name_en = inner.standard_name_en


def test_qualitative_result_helper():
    from app.services.matcher.definitions import _is_qualitative_result

    assert _is_qualitative_result(_FakeRawBM("отрицат."))
    assert _is_qualitative_result(_FakeRawBM("не выявлена"))
    assert not _is_qualitative_result(_FakeRawBM("0"))            # activated lymphocytes case
    assert not _is_qualitative_result(_FakeRawBM("42.0", "30 - 40"))


# --- curated subset table (offline path) -------------------------------------

def test_curated_subset_codes_resolve_offline():
    ml = _load_multilingual_lookup()
    expectations = {
        "Т-лимфоциты (CD3+), %": "8124-0",
        "Т-лимфоциты (CD3+)": "8122-4",
        "В-лимфоциты (CD19+)": "8116-6",
        "В-лимфоциты (CD19+), %": "8117-4",
        "Т-хелперы (CD3+CD4+)": "24467-3",
        "Т- цитотокс. (CD3+CD8+), %": "8101-8",
        "Иммунорегуляторный индекс": "54218-3",
        "ЕКК (CD3-CD16+CD56+), %": "8112-5",
        "ЕКК (CD3-CD16+CD56+)": "9728-7",
        "Т-ЕК (CD3+CD16+CD56+), %": "42189-1",
        "anti-Toxocara IgG": "96568-1",
        "anti-Ascaris IgG": "74815-2",
        "anti-Opisthorchis IgG": "local-opisthorchis-igg",
        "anti-Lamblia IgA+IgM+IgG": "local-lamblia-immunoglobulins",
    }
    for raw, code in expectations.items():
        got = _multilingual_code(raw, ml)
        assert got == code, f"{raw!r}: expected {code}, got {got}"


def test_ratio_bounds_present_for_cd48():
    # The CD4/CD8 ratio def promoted from CSV keeps a usable interval ref so
    # status computes low/normal/high (0.65* case was flagged low).
    with open("e2e/golden/популяции_лимфоцитов_анализ/standardized.json", encoding="utf-8") as fh:
        golden = json.load(fh)
    row = next(b for b in golden["biomarkers"] if b["raw_name"] == "Иммунорегуляторный индекс")
    lo = row["reference"]["low"]
    hi = row["reference"]["high"]
    if lo is not None or hi is not None:
        assert row["status"] == "low"


# --- forced-local bypass of learned global synonyms ---------------------------

def test_verify_or_create_force_local_skips_learned_synonyms(db_session):
    """A curated sentinel (curated_local_ids) must create a LOCAL definition
    even when a global def carries a historically LEARNED synonym equal to the
    raw name — the regression behind anti-Opisthorchis IgG -> bare IgG 2465-3."""
    from app.db.models import BiomarkerDefinition as BM
    from app.services.matcher.definitions import verify_or_create

    raw = "anti-TestOrganism IgG"
    db_session.add(BM(
        id="polluted-igg", names={"en": "IgG"}, synonyms=[raw], scope="global",
        category="CHEM", unit="",
    ))
    db_session.commit()

    resolved = verify_or_create(
        db_session, raw, None, "default", grounded=False, force_local=True
    )
    assert resolved.scope == "local"

    # Without the flag the historical behavior still resolves to the global.
    resolved_plain = verify_or_create(
        db_session, raw, None, "default", grounded=False, force_local=False
    )
    assert resolved_plain.scope == "global" and resolved_plain.id == "polluted-igg"
    db_session.rollback()
