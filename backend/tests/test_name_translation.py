"""
Regression tests for ISSUES.md #50 (Latin-script non-English biomarker names
were never translated).

The batch name translator required a NON-ASCII raw name before sending a
biomarker to the LLM, so Spanish "Bilirrubina total" (ASCII, not English,
empty standard_name_en) was skipped — contradicting the module's own prompt
example and over-producing user-local definitions for analytes the global
dictionary already covers.
"""
import json
from types import SimpleNamespace

from app.schemas.ai import RawBiomarker
from app.services.matcher.translation import _translate_names_batch


def _fake_client(payload):
    """A Mistral-shaped client whose parse() records the prompt and returns
    the given JSON payload."""
    seen = {}

    def parse(**kw):
        seen["system"] = kw["messages"][0]["content"]
        message = SimpleNamespace(content=json.dumps(payload))
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    return SimpleNamespace(chat=SimpleNamespace(parse=parse)), seen


def test_latin_non_english_name_is_translated():
    rows = [
        RawBiomarker(name="Bilirrubina total", value="5", unit="mmol/L"),
        RawBiomarker(name="Hemoglobina", value="140", unit="g/L"),
    ]
    client, seen = _fake_client({"guesses": [
        {"raw_name": "Bilirrubina total", "standard_name_en": "Total bilirubin",
         "guessed_loinc": None},
        {"raw_name": "Hemoglobina", "standard_name_en": "Hemoglobin",
         "guessed_loinc": None},
    ]})
    out = _translate_names_batch(rows, client)
    assert out == {
        "Bilirrubina total": "Total bilirubin",
        "Hemoglobina": "Hemoglobin",
    }
    # Both names were sent to the LLM.
    assert '"Bilirrubina total"' in seen["system"]
    assert '"Hemoglobina"' in seen["system"]
    # The translation is persisted back onto the raw biomarkers.
    assert rows[0].standard_name_en == "Total bilirubin"
    assert rows[1].standard_name_en == "Hemoglobin"


def test_english_name_with_ascii_standard_is_skipped():
    rows = [RawBiomarker(name="Glucose", value="4", unit="mmol/L",
                         standard_name_en="Glucose")]
    client, seen = _fake_client({"guesses": []})
    out = _translate_names_batch(rows, client)
    assert out == {}
    assert "Glucose" not in seen.get("system", "")


def test_non_ascii_standard_name_with_english_name_is_resent():
    """A biomarker whose standard_name_en is non-ASCII (garbage from a prior
    stage) is re-sent even when the raw name is English — the effective
    English name is not usable."""
    rows = [RawBiomarker(name="Glucose", value="4", unit="mmol/L",
                         standard_name_en="Глюкоза")]
    client, seen = _fake_client({"guesses": [
        {"raw_name": "Glucose", "standard_name_en": "Glucose",
         "guessed_loinc": None},
    ]})
    out = _translate_names_batch(rows, client)
    assert out == {"Glucose": "Glucose"}
    assert '"Glucose"' in seen["system"]
