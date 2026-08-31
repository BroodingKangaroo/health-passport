"""Tests for non-finite rejection in value parsing (#48).

A NaN/inf parsed out of an extraction would poison compute_status (NaN
comparisons are all False → "normal") and serialise as non-standard JSON.
"""
import pytest

from app.services.reference import _parse_numeric_token, parse_value


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

