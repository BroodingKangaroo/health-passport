"""Regression tests for the lg→linear anchoring fix (колонофлор_16_13.05,
2026-08-29).

The `lg` unit prefix still MEANS log10 — values convert via the deterministic
10^x scale function — but a log-scale unit must never become the CANONICAL
unit of a definition:

- "lg копий/мл" / "lg copies/mL" anchors canonical "copies/mL" (linear) with
  a 10^x-scaled interval reference; readings in the log unit convert at read
  time ("scale_function: 10^x").
- "ln …" anchors the linear magnitude ("exp(x)").
- Ratio-like analytes are dimensionless: a log prefix on their unit column is
  a table-header artifact, so the canonical is "ratio" and nothing is scaled.
- Qualitative screens (no digits in value/range) keep the unitless anchor.
- Canonical absent strings ("Not detected", …) against a different canonical
  unit never surface needs_review — there is no quantity to convert.
"""

import pytest

from app.schemas.ai import RawBiomarker
from app.services.matcher.definitions import (
    _linearized_anchor,
    verify_or_create,
)
from app.services.matcher.standardize import _build_standardized_local
from app.services.matcher.units_conversion import _convert_to_canonical
from app.services.reference import compute_status

MICROBIOME_CAT = "Исследование состава микробиоты толстого кишечника"


def _raw(name, value, unit, rng="", en="", category=MICROBIOME_CAT):
    return RawBiomarker(
        name=name, value=value, unit=unit, raw_range_string=rng,
        category=category, standard_name_en=en,
    )


# --- anchor linearization matrix (pure helper) --------------------------------

@pytest.mark.parametrize(("translation", "names", "exp_unit", "exp_kind", "exp_sf"), [
    ({"unit": "lg copies/mL", "kind": "log10", "inferred": False},
     ("Blautia spp",), "copies/mL", "linear", "10^x"),
    # Offline identity path: Cyrillic magnitude mapped deterministically.
    ({"unit": "lg копий/мл", "kind": "log10", "inferred": False},
     ("Blautia spp",), "copies/mL", "linear", "10^x"),
    ({"unit": "log10 копий/мл", "kind": "log10", "inferred": False},
     ("X",), "copies/mL", "linear", "10^x"),
    ({"unit": "ln копий/мл", "kind": "ln", "inferred": False},
     ("X",), "copies/mL", "linear", "exp(x)"),
    # Ratio analytes: dimensionless, nothing scaled.
    ({"unit": "lg копий/мл", "kind": "log10", "inferred": False},
     ("Bacteroides spp./Faecalibacterium prausnitzii ratio",), "ratio", "linear", None),
    ({"unit": "lg copies/mL", "kind": "log10", "inferred": False},
     ("Соотношение Bacteroides spp и F. prausnitzii",), "ratio", "linear", None),
    # Linear units pass through untouched; log kind without a strippable
    # prefix is left alone (defensive).
    ({"unit": "copies/mL", "kind": "linear", "inferred": False},
     ("X",), "copies/mL", "linear", None),
    ({"unit": "lg", "kind": "log10", "inferred": False}, ("X",), "lg", "log10", None),
])
def test_linearized_anchor_matrix(translation, names, exp_unit, exp_kind, exp_sf):
    out, sf = _linearized_anchor(translation, *names)
    assert out["unit"] == exp_unit
    assert out["kind"] == exp_kind
    assert sf == exp_sf


# --- first-seen anchoring (DB) -------------------------------------------------

def test_lg_unit_anchors_linear_canonical_and_scaled_reference(db_session):
    from app.services.reference import parse_reference

    defn = verify_or_create(
        db_session, "Blautia spp.", None, "user-a",
        _raw("Blautia spp.", "5", "lg копий/мл", "8 - 11", en="Blautia spp"),
    )
    assert defn.canonical_unit == "copies/mL"
    assert defn.canonical_kind == "linear"
    # The def's stored reference must live in the LINEAR canonical scale
    # (8 lg → 1e8, 11 lg → 1e11), not the document's log scale.
    assert defn.reference == {"kind": "interval", "low": 1e8, "high": 1e11}
    # Sanity: the unscaled parse would have been 8..11.
    assert parse_reference("8 - 11") == {"kind": "interval", "low": 8.0, "high": 11.0}


def test_lg_reading_converts_deterministically(db_session):
    defn = verify_or_create(
        db_session, "Blautia spp.", None, "user-a",
        _raw("Blautia spp.", "5", "lg копий/мл", "8 - 11", en="Blautia spp"),
    )
    res = _build_standardized_local(
        _raw("Blautia spp.", "5", "lg копий/мл", "8 - 11", en="Blautia spp"),
        defn, None,
    )
    assert res.standard_value == 100000.0
    assert res.standard_unit == "copies/mL"
    assert res.scale_function == "10^x"
    assert res.needs_review is False
    assert res.reference.low == 1e8 and res.reference.high == 1e11
    assert compute_status(res.standard_value, res.reference) == "low"


def test_lg_absent_reading_stays_zero_with_scaled_bound(db_session):
    defn = verify_or_create(
        db_session, "Acinetobacter spp.", None, "user-a",
        _raw("Acinetobacter spp.", "не обнар", "lg копий/мл", "< 6",
             en="Acinetobacter spp"),
    )
    assert defn.canonical_unit == "copies/mL"
    assert defn.reference == {"kind": "interval", "low": None, "high": 1e6}
    res = _build_standardized_local(
        _raw("Acinetobacter spp.", "не обнар", "lg копий/мл", "< 6",
             en="Acinetobacter spp"),
        defn, None,
    )
    assert res.standard_value == 0.0
    assert res.standard_unit == "copies/mL"
    assert res.scale_function == "10^x"
    assert res.needs_review is False
    assert res.reference.high == 1e6
    assert compute_status(res.standard_value, res.reference) == "normal"


def test_ratio_row_anchors_ratio_unit_without_scaling(db_session):
    name = "Соотношение Bacteroides spp./ Faecalibacterium prausnitzii"
    en = "Bacteroides spp./Faecalibacterium prausnitzii ratio"
    defn = verify_or_create(
        db_session, name, None, "user-a",
        _raw(name, "1.14", "lg копий/мл", "0.01 - 100", en=en),
    )
    assert defn.canonical_unit == "ratio"
    assert defn.canonical_kind == "linear"
    assert defn.reference == {"kind": "interval", "low": 0.01, "high": 100.0}
    res = _build_standardized_local(
        _raw(name, "1.14", "lg копий/мл", "0.01 - 100", en=en), defn, None,
    )
    assert res.standard_value == 1.14
    assert res.standard_unit == "ratio"
    assert res.scale_function is None
    assert res.needs_review is False
    assert compute_status(res.standard_value, res.reference) == "normal"


def test_ratio_row_anchors_ratio_over_leaked_concentration_unit(db_session):
    """ISSUES.md #46: a ratio analyte whose table leaks a LINEAR
    concentration unit (мг/дл column header) must anchor 'ratio', not the
    concentration — previously the ratio check only ran for log-kind/empty
    units, so the _convert_to_canonical ratio pass-through never fired and
    every later reading of the def was measured against a concentration
    canonical."""
    name = "Соотношение Bacteroides и Prevotella"
    en = "Bacteroides/Prevotella ratio"
    defn = verify_or_create(
        db_session, name, None, "user-a",
        _raw(name, "1.2", "мг/дл", "0.5 - 2.0", en=en),
    )
    assert defn.canonical_unit == "ratio"
    assert defn.canonical_kind == "linear"
    res = _build_standardized_local(
        _raw(name, "1.2", "мг/дл", "0.5 - 2.0", en=en), defn, None,
    )
    assert res.standard_value == 1.2
    assert res.standard_unit == "ratio"
    assert res.scale_function is None
    assert res.needs_review is False


def test_qualitative_lg_row_anchors_unitless(db_session):
    defn = verify_or_create(
        db_session, "Bacteroides thetaiotaomicron", None, "user-a",
        _raw("Bacteroides thetaiotaomicron", "не обнар", "lg копий/мл", "",
             en="Bacteroides thetaiotaomicron"),
    )
    assert defn.canonical_unit == ""
    res = _build_standardized_local(
        _raw("Bacteroides thetaiotaomicron", "не обнар", "lg копий/мл", "",
             en="Bacteroides thetaiotaomicron"),
        defn, None,
    )
    assert res.standard_value == "Not detected"
    # A unitless qualitative def must not leak the raw unit column (or an
    # invented guess) onto the reading.
    assert res.standard_unit == ""
    assert res.needs_review is False


# --- read-path guards ----------------------------------------------------------

def test_absent_string_against_foreign_canonical_is_not_flagged(db_session):
    defn = verify_or_create(
        db_session, "Candida albicans", None, "user-a",
        _raw("Candida albicans", "3", "", "", en="Candida albicans"),
    )
    assert defn.canonical_unit == "copies/mL"
    value, unit, sf, nr = _convert_to_canonical(
        "Not detected",
        _raw("Candida albicans", "не обнар", "lg копий/мл", "", en="Candida albicans"),
        defn, None,
    )
    assert (value, unit, sf, nr) == ("Not detected", "copies/mL", None, False)


def test_present_string_against_foreign_canonical_still_flagged(db_session):
    defn = verify_or_create(
        db_session, "Candida albicans", None, "user-a",
        _raw("Candida albicans", "3", "", "", en="Candida albicans"),
    )
    _, _, _, nr = _convert_to_canonical(
        "Present",
        _raw("Candida albicans", "обнар.", "lg копий/мл", "", en="Candida albicans"),
        defn, None,
    )
    assert nr is True


def test_ratio_canonical_passes_numeric_through(db_session):
    name = "Соотношение A/B"
    defn = verify_or_create(
        db_session, name, None, "user-a",
        _raw(name, "1.14", "lg копий/мл", "0.01 - 100", en="A/B ratio"),
    )
    value, unit, sf, nr = _convert_to_canonical(
        1.14,
        _raw(name, "1.14", "lg копий/мл", "0.01 - 100", en="A/B ratio"),
        defn, None,
    )
    assert (value, unit, sf, nr) == (1.14, "ratio", None, False)


# --- migration script ------------------------------------------------------------

def test_migrate_log_anchored_defs(db_session):
    from app.db.models import BiomarkerReading as BR
    from scripts.migrate_lg_to_linear import _migrate_def, migrate_log_anchored_defs

    defn = verify_or_create(
        db_session, "Blautia spp.", None, "user-a",
        _raw("Blautia spp.", "5", "lg копий/мл", "8 - 11", en="Blautia spp"),
    )
    # Simulate the LEGACY state this migration exists for: a def anchored
    # before the linearization fix (canonical_unit in the log scale, the
    # reference left in the document's log units).
    defn.canonical_unit = "lg copies/mL"
    defn.canonical_kind = "log10"
    defn.reference = {"kind": "interval", "low": 8.0, "high": 11.0}
    reading = BR(
        entry_id="entry-x", biomarker_id=defn.id, value=5.0,
        reference={"kind": "interval", "low": 8.0, "high": 11.0},
        status="low", original_name="Blautia spp.", original_value="5",
        original_unit="lg копий/мл", original_range="8 - 11",
    )
    db_session.add(reading)
    db_session.flush()

    plan = _migrate_def(defn)
    assert plan == {"unit": "copies/mL", "scale_fn": "10^x", "scale_values": True}

    report = migrate_log_anchored_defs(db_session)
    assert report["defs"] == 1
    assert report["readings"] == 1

    db_session.refresh(defn)
    db_session.refresh(reading)
    assert defn.canonical_unit == "copies/mL"
    assert defn.canonical_kind == "linear"
    assert defn.reference == {"kind": "interval", "low": 1e8, "high": 1e11}
    assert reading.value == 100000.0
    assert reading.reference == {"kind": "interval", "low": 1e8, "high": 1e11}
    assert reading.scale_function == "10^x"
    assert reading.status == "low"

    # Idempotent: a second pass changes nothing.
    report2 = migrate_log_anchored_defs(db_session)
    assert report2["defs"] == 0 and report2["readings"] == 0


def test_migrate_ratio_def_sets_ratio_unit_without_touching_values(db_session):
    from app.db.models import BiomarkerReading as BR
    from scripts.migrate_lg_to_linear import migrate_log_anchored_defs

    name = "Соотношение Bacteroides spp./ Faecalibacterium prausnitzii"
    en = "Bacteroides spp./Faecalibacterium prausnitzii ratio"
    defn = verify_or_create(
        db_session, name, None, "user-a",
        _raw(name, "1.14", "lg копий/мл", "0.01 - 100", en=en),
    )
    # Legacy state: a ratio def that anchored the log-scale unit.
    defn.canonical_unit = "lg copies/mL"
    defn.canonical_kind = "log10"
    reading = BR(
        entry_id="entry-y", biomarker_id=defn.id, value=1.14,
        reference={"kind": "interval", "low": 0.01, "high": 100.0},
        status="normal", original_name=name, original_value="1.14",
        original_unit="lg копий/мл", original_range="0.01 - 100",
    )
    db_session.add(reading)
    db_session.flush()

    report = migrate_log_anchored_defs(db_session)
    assert report["defs"] == 1
    db_session.refresh(defn)
    db_session.refresh(reading)
    assert defn.canonical_unit == "ratio"
    assert defn.reference == {"kind": "interval", "low": 0.01, "high": 100.0}
    assert reading.value == 1.14
    assert reading.scale_function is None
    assert reading.status == "normal"


# --- batch unit-translation guard (degenerate LLM answers) ---------------------

class _FakeMsg:
    def __init__(self, content):
        self.content = content


class _FakeResp:
    def __init__(self, content):
        self.choices = [type("C", (), {"message": _FakeMsg(content)})()]


def _fake_client(payload):
    import json as _json
    from types import SimpleNamespace
    return SimpleNamespace(chat=SimpleNamespace(
        parse=lambda **kw: _FakeResp(_json.dumps(payload))
    ))


def test_batch_translator_rejects_empty_and_prefix_dropping_answers():
    from app.services.matcher._cache import _unit_translation_cache
    from app.services.matcher.units_guess import _translate_units_batch

    _unit_translation_cache.clear()
    rows = [
        RawBiomarker(name="Blautia spp", value="5", unit="lg копий/мл",
                     standard_name_en="Blautia spp"),
        RawBiomarker(name="X spp", value="5", unit="ln копий/мл",
                     standard_name_en="X spp"),
    ]
    # mistral-medium intermittently returns an EMPTY unit for "lg копий/мл"
    # and a prefix-dropping "copies/mL" for a log-scale raw — both would
    # corrupt the canonical anchor (empty canonical / linear canonical for
    # log-scale values). The guard falls back to the identity translation.
    client = _fake_client({"translations": [
        {"unit": "", "kind": "linear", "inferred": False},
        {"unit": "copies/mL", "kind": "linear", "inferred": False},
    ]})
    out = _translate_units_batch(rows, client)
    assert out["lg копий/мл"] == {"unit": "lg копий/мл", "kind": "log10", "inferred": False}
    assert out["ln копий/мл"] == {"unit": "ln копий/мл", "kind": "ln", "inferred": False}

    # A well-behaved answer is accepted, with the kind recomputed from the
    # unit's own prefix (never trusted from the model).
    _unit_translation_cache.clear()
    client = _fake_client({"translations": [
        {"unit": "lg copies/mL", "kind": "linear", "inferred": False},
    ]})
    out = _translate_units_batch(rows[:1], client)
    assert out["lg копий/мл"] == {"unit": "lg copies/mL", "kind": "log10", "inferred": False}
    _unit_translation_cache.clear()


def test_batch_translator_keys_on_echoed_raw_unit():
    """ISSUES.md #49: answers are keyed on the raw unit each item echoes, so
    a REORDERED answer list can no longer mis-key the translation cache
    (previously a positional zip paired each answer with whatever unit
    happened to sit at the same index)."""
    from app.services.matcher._cache import _unit_translation_cache
    from app.services.matcher.units_guess import _translate_units_batch

    _unit_translation_cache.clear()
    rows = [
        RawBiomarker(name="Alpha", value="5", unit="мг/дл", standard_name_en="Alpha"),
        RawBiomarker(name="Blautia spp", value="5", unit="lg копий/мл",
                     standard_name_en="Blautia spp"),
    ]
    client = _fake_client({"translations": [
        {"raw_unit": "lg копий/мл", "unit": "lg copies/mL", "kind": "log10", "inferred": False},
        {"raw_unit": "мг/дл", "unit": "mg/dL", "kind": "linear", "inferred": False},
    ]})
    out = _translate_units_batch(rows, client)
    assert out["lg копий/мл"] == {"unit": "lg copies/mL", "kind": "log10", "inferred": False}
    assert out["мг/дл"] == {"unit": "mg/dL", "kind": "linear", "inferred": False}
    _unit_translation_cache.clear()


def test_batch_translator_dedupes_shared_unit_first_meta_wins():
    """Biomarkers sharing one unit string produce a single LLM item (the
    cache is keyed by unit), and the first-seen name/category is used."""
    import json as _json
    from types import SimpleNamespace

    from app.services.matcher._cache import _unit_translation_cache
    from app.services.matcher.units_guess import _translate_units_batch

    _unit_translation_cache.clear()
    rows = [
        RawBiomarker(name="Альфа", value="5", unit="ммоль/л", standard_name_en="Alpha"),
        RawBiomarker(name="Бета", value="4", unit="ммоль/л", standard_name_en="Beta"),
    ]
    seen = {}

    def parse(**kw):
        seen["system"] = kw["messages"][0]["content"]
        return _FakeResp(_json.dumps({"translations": [
            {"raw_unit": "ммоль/л", "unit": "mmol/L", "kind": "linear", "inferred": False},
        ]}))

    client = SimpleNamespace(chat=SimpleNamespace(parse=parse))
    out = _translate_units_batch(rows, client)
    assert out["ммоль/л"] == {"unit": "mmol/L", "kind": "linear", "inferred": False}
    assert seen["system"].count("| 'ммоль/л'") == 1
    assert "Alpha" in seen["system"] and "Beta" not in seen["system"]
    _unit_translation_cache.clear()
