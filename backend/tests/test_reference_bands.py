"""Tests for the matcher-side band-aware reference fallback (helix_2023).

Segmented lab reference texts ("желательный ... <5.17, пограничный ...") are
unparseable by ``reference.parse_reference``; a numeric reading should get the
first (optimal/negative-cutoff) band as an interval, while age/sex-banded and
qualitative-value rows keep the original parse.
"""

from app.services.matcher.reference_bands import parse_reference_for_value
from app.services.reference import parse_reference


def test_first_band_high_bound_extracted():
    text = ("желательный уровень холестерина <5.17, пограничный уровень "
            "холестерина 5.17-6.18, высокий уровень холестерина >6.21")
    assert parse_reference_for_value(text, 4.2) == {
        "kind": "interval", "low": None, "high": 5.17,
    }


def test_risk_band_list_uses_optimal_band():
    text = ("Уровни с учетом риска развития коронарной болезни сердца: "
            "<2.59 - оптимальный, 2.59-3.34 - выше оптимального")
    assert parse_reference_for_value(text, 2.46) == {
        "kind": "interval", "low": None, "high": 2.59,
    }


def test_serology_cutoff_band():
    text = ("до 0.9 - отрицательный (нереактивный), от 0.9 до 1.0 - серая "
            "зона (пограничный), от 1.0 - положительный (реактивный)")
    assert parse_reference_for_value(text, 0.05) == {
        "kind": "interval", "low": None, "high": 0.9,
    }


def test_age_sex_banded_text_is_left_alone():
    text = "Сыворотка: взрослые < 60 лет 4.11-5.89; 60-90 лет 4.56-6.38"
    assert parse_reference_for_value(text, 5.17) is None


def test_age_qualifier_word_is_left_alone():
    text = "Взрослые: до 21, Дети: >1месяца: до 17"
    assert parse_reference_for_value(text, 11.1) == parse_reference(text)


def test_qualitative_value_keeps_original_result():
    text = "до 0.9 - отрицательный"
    assert parse_reference_for_value(text, "отрицат.") == parse_reference(text)


def test_already_parsed_interval_untouched():
    assert parse_reference_for_value("0.01 - 5", 0.6) == {
        "kind": "interval", "low": 0.01, "high": 5.0,
    }
