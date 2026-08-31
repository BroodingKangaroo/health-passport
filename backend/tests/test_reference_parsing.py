"""Tests for reference/value parsing edge cases.

#48: a NaN/inf parsed out of an extraction would poison compute_status (NaN
comparisons are all False → "normal") and serialise as non-standard JSON.
#44: a glued-unit numeric range ("3.9-6.1 ммоль/л") must parse as an
interval, not degrade to a junk qualitative reference that marks numeric
values "abnormal"; unparseable numeric ranges yield an unknown (None)
reference and an unknown ("") status.
"""
import pytest

from app.services.reference import (
    _parse_numeric_token,
    compute_status,
    parse_reference,
    parse_value,
)


@pytest.mark.parametrize("raw", ["nan", "NAN", "NaN", "inf", "-inf", "Infinity"])
def test_parse_value_rejects_non_finite(raw):
    assert parse_value(raw) is None


@pytest.mark.parametrize("raw", ["nan", "inf", "-inf", "Infinity"])
def test_parse_numeric_token_rejects_non_finite(raw):
    assert _parse_numeric_token(raw) is None


def test_parse_value_still_parses_plain_numbers():
    assert parse_value("5.5") == 5.5
    assert parse_value("8,75") == pytest.approx(8.75)
    assert parse_value("9*10^7") == 9e7
    assert parse_value("") is None
    assert parse_value(None) is None


def test_parse_value_rejects_numeric_overflow():
    # A digit run too large for a float must not become inf.
    assert parse_value("9" * 400) is None


# --- #44: glued-unit ranges / unknown references ---------------------------

@pytest.mark.parametrize(
    "raw, low, high",
    [
        ("3.9-6.1 ммоль/л", 3.9, 6.1),
        ("4 - 11 g/dL", 4.0, 11.0),
        ("8,75-10,5 ммоль/л", 8.75, 10.5),
        ("9*10^7 - 1*10^8 копий/мл", 9e7, 1e8),
        ("10^3-10^5 КОЕ/мл", 1e3, 1e5),
        ("10^12/л - 10^13/л", 1e12, 1e13),
    ],
)
def test_parse_reference_range_with_glued_unit(raw, low, high):
    assert parse_reference(raw) == {"kind": "interval", "low": low, "high": high}


@pytest.mark.parametrize(
    "raw",
    [
        "1:20-1:40",  # titer — numeric-looking but not a clean range
        "3.9-шесть",  # half-numeric range
        "2026-01-02",  # a date is not a reference range
    ],
)
def test_parse_reference_unparseable_numeric_range_is_unknown(raw):
    assert parse_reference(raw) is None


def test_parse_reference_qualitative_with_dash_still_qualitative():
    # No digits → the qualitative fallback is preserved.
    assert parse_reference("отрицательно-положительно") == {
        "kind": "qualitative",
        "expected": "отрицательно-положительно",
    }


def test_parse_reference_plain_forms_unaffected():
    assert parse_reference("8 - 11") == {"kind": "interval", "low": 8.0, "high": 11.0}
    assert parse_reference("< 5") == {"kind": "interval", "low": None, "high": 5.0}
    assert parse_reference("не выявлено") == {
        "kind": "qualitative",
        "expected": "Not detected",
    }


def test_qual_status_unknown_for_unrecognized_expected_with_numeric_value():
    junk = {"kind": "qualitative", "expected": "3.9-6.1 ммоль/л"}
    assert compute_status(5.0, junk) == ""
    assert compute_status(0, junk) == ""

    free_text = {"kind": "qualitative", "expected": "что-то"}
    assert compute_status(5.0, free_text) == ""

    # Recognised categories keep their bridging semantics.
    assert compute_status(0, {"kind": "qualitative", "expected": "Negative"}) == "normal"
    assert compute_status(5.0, {"kind": "qualitative", "expected": "Negative"}) == "abnormal"
    assert compute_status(5.0, {"kind": "qualitative", "expected": "Positive"}) == "normal"
    assert compute_status(0, {"kind": "qualitative", "expected": "Positive"}) == "abnormal"

