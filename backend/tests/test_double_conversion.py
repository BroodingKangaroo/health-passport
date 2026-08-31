"""
Regression tests for ISSUES.md #45 (double unit conversion in the
no-printed-range path).

``_build_standardized_from_def`` used to run ``convert_units`` toward
``defn.unit`` — for local defs the anchor document's *raw* unit, possibly
log-scale — BEFORE ``_convert_to_canonical``. A hallucinated LLM factor
multiplied the value and passed through with ``needs_review=False``. The
canonical pass alone must land the value; ``convert_units`` is kept only for
legacy NULL-canonical defs with a linear stored unit, and log-scale targets
are refused outright.
"""
import pytest

from app.db.models import BiomarkerDefinition
from app.schemas.ai import RawBiomarker
from app.services.matcher import standardize as std_mod
from app.services.matcher import units_conversion
from app.services.matcher.definitions import verify_or_create

MICROBIOME_CAT = "Исследование состава микробиоты толстого кишечника"


def _raw(name, value, unit, rng="", en="", category=MICROBIOME_CAT):
    return RawBiomarker(
        name=name, value=value, unit=unit, raw_range_string=rng,
        category=category, standard_name_en=en,
    )


@pytest.fixture
def hallucinated_factor(monkeypatch):
    """Simulate an LLM conversion-factor hallucination: every factor request
    returns 1000. The no-doc path must not let it touch the value when the
    canonical pass alone is enough."""
    monkeypatch.setattr(
        units_conversion, "_llm_conversion_factor", lambda *a, **kw: 1000.0
    )


def _lg_anchored_def(db_session):
    """A local def anchored from a log-scale document: canonical is the linear
    magnitude, the stored raw unit stays 'lg копий/мл'."""
    return verify_or_create(
        db_session, "Blautia spp.", None, "user-a",
        _raw("Blautia spp.", "5", "lg копий/мл", "8 - 11", en="Blautia spp"),
    )


def test_canonical_def_skips_convert_units(db_session, hallucinated_factor):
    defn = _lg_anchored_def(db_session)
    assert defn.canonical_unit == "copies/mL"
    assert defn.unit == "lg копий/мл"  # raw anchor unit, log-scale

    # A linear reading of the same analyte without a printed range: the
    # double conversion would have applied the bogus ×1000 factor.
    res = std_mod._build_standardized_from_def(
        _raw("Blautia spp.", "300000", "copies/mL", en="Blautia spp"),
        defn, None,
    )
    assert res.standard_value == 300000.0
    assert res.standard_unit == "copies/mL"
    assert res.needs_review is False


def test_log_reading_still_scales_deterministically(db_session, hallucinated_factor):
    """The legitimate 10^x path is unaffected: a log-unit reading against the
    linear canonical converts via the deterministic scale function."""
    defn = _lg_anchored_def(db_session)
    res = std_mod._build_standardized_from_def(
        _raw("Blautia spp.", "5", "lg копий/мл", en="Blautia spp"),
        defn, None,
    )
    assert res.standard_value == 100000.0
    assert res.standard_unit == "copies/mL"
    assert res.scale_function == "10^x"
    assert res.needs_review is False


def test_legacy_linear_def_keeps_convert_units(db_session, monkeypatch):
    """Legacy NULL-canonical defs with a linear stored unit keep the
    pre-canonical convert_units pass (behavior preserved)."""
    calls = []
    real_convert = units_conversion.convert_units

    def spy(value, raw_unit, target_unit, **kw):
        calls.append((raw_unit, target_unit))
        return real_convert(value, raw_unit, target_unit, **kw)

    monkeypatch.setattr(std_mod, "convert_units", spy)

    defn = BiomarkerDefinition(
        id="local-user-a-legacy1",
        names={"en": "Glucose Legacy"},
        synonyms=["Glucose Legacy"],
        category="Chemistry",
        reference={"kind": "interval", "low": 3.9, "high": 6.1},
        unit="mmol/L",
        scope="local",
        user_id="user-a",
        canonical_unit=None,
    )
    db_session.add(defn)
    db_session.commit()

    res = std_mod._build_standardized_from_def(
        _raw("Glucose Legacy", "5.5", "ммоль/л", en="Glucose Legacy"),
        defn, None,
    )
    assert res.standard_value == 5.5
    assert calls, "convert_units must still run for legacy NULL-canonical defs"


def test_legacy_log_scale_target_refused(db_session, hallucinated_factor):
    """A legacy NULL-canonical def whose stored unit is log-scale must not
    get a multiplicative conversion toward it — the value stays in the
    document's own unit instead of being corrupted."""
    defn = BiomarkerDefinition(
        id="local-user-a-legacy2",
        names={"en": "Legacy Log Analyte"},
        synonyms=["Legacy Log Analyte"],
        category="General",
        reference=None,
        unit="lg копий/мл",
        scope="local",
        user_id="user-a",
        canonical_unit=None,
    )
    db_session.add(defn)
    db_session.commit()

    res = std_mod._build_standardized_from_def(
        _raw("Legacy Log Analyte", "5", "copies/mL", en="Legacy Log Analyte"),
        defn, None,
    )
    assert res.standard_value == 5.0
    assert res.standard_unit == "copies/mL"
    assert res.needs_review is False
