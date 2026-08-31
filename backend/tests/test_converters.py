"""Unit tests for localized-unit normalization and value conversion."""

import pytest

from app.services import converters


def test_normalize_localized_units():
    assert converters.normalize_unit("ммоль/л") == "mmol/L"
    assert converters.normalize_unit("мкмоль/л") == "\u00b5mol/L"
    assert converters.normalize_unit("г/л") == "g/L"
    assert converters.normalize_unit("МЕ/л") == "IU/L"
    assert converters.normalize_unit("Ед/л") == "U/L"
    assert converters.normalize_unit("мм/ч") == "mm/h"
    # Unknown units pass through unchanged (trimmed).
    assert converters.normalize_unit(" mg/dL ") == "mg/dL"
    assert converters.normalize_unit("") == ""


def test_cyrillic_molar_mass_conversion():
    # Glucose 5.5 mmol/L -> mg/dL (MW 180.16): ~99.1
    val, method = converters.convert_value(5.5, "ммоль/л", "mg/dL", "glucose")
    assert method == "molar_mass"
    assert abs(val - 99.088) < 0.5

    # Bilirubin 8.5 umol/L -> mg/dL (MW 584.66): ~0.497
    val, method = converters.convert_value(8.5, "мкмоль/л", "mg/dL", "bilirubin")
    assert method == "molar_mass"
    assert abs(val - 0.497) < 0.05


def test_cyrillic_dimensional_conversion():
    # Hemoglobin 150 g/L -> g/dL: 15.0
    val, method = converters.convert_value(150.0, "г/л", "g/dL", "hemoglobin")
    assert method == "dimensional"
    assert abs(val - 15.0) < 0.01


def test_identity_after_normalization():
    val, method = converters.convert_value(8.5, "мкмоль/л", "umol/L", "bilirubin")
    assert method == "identity"
    assert val == 8.5


def test_round_sig_preserves_trace_values():
    # Fixed-decimal rounding (round(x, 4)) would map 0.00005 → 0.0 → false "low".
    assert converters.apply_factor(0.00005, 1.0) == pytest.approx(0.00005)
    assert converters._round_sig(0.00005) == pytest.approx(0.00005)
    assert converters._round_sig(123.456789) == pytest.approx(123.457)
    assert converters._round_sig(-0.000123456) == pytest.approx(-0.000123456)
    assert converters._round_sig(0.0) == 0.0


def test_convert_value_keeps_trace_magnitude():
    # 0.00005 umol/L -> umol/L is identity, so the value must survive intact.
    val, method = converters.convert_value(0.00005, "umol/L", "umol/L", "bilirubin")
    assert method == "identity"
    assert val == pytest.approx(0.00005)
