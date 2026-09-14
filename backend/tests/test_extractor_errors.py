"""F11 exit-code taxonomy: chat auth/quota classification must surface as a
typed error for the benchmark (instead of the silent fallback record), while
the live pipeline keeps its fallback behavior."""

import pytest

from app.services.extractor import (
    LLMProcessingError,
    _classify_chat_error,
    llm_extract,
)


class _Err(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        if status is not None:
            self.status_code = status


class _ChatRaises:
    def __init__(self, exc):
        self.exc = exc

    def parse(self, **kwargs):
        raise self.exc


class _Client:
    def __init__(self, exc):
        self.chat = _ChatRaises(exc)


def test_classify_auth_quota_and_unknown():
    assert _classify_chat_error(_Err("nope", 401)).kind == "auth"
    assert _classify_chat_error(_Err("nope", 403)).kind == "auth"
    assert _classify_chat_error(_Err("OpenRouter HTTP 429: rate limited")).kind == "quota"
    assert _classify_chat_error(_Err("Status 500 upstream")).kind == "unknown"
    assert _classify_chat_error(_Err("socket closed")).kind == "unknown"


def test_llm_extract_hard_error_raises_for_auth():
    with pytest.raises(LLMProcessingError) as excinfo:
        llm_extract("markdown", _Client(_Err("bad key", 401)), raise_on_hard_error=True)
    assert excinfo.value.kind == "auth"


def test_llm_extract_default_keeps_silent_fallback():
    record = llm_extract("markdown", _Client(_Err("bad key", 401)))
    assert record.entry_type == "unknown"
    assert record.notes.startswith("Raw OCR text:")


def test_llm_extract_other_errors_fallback_even_with_raising_enabled():
    record = llm_extract("markdown", _Client(_Err("500 upstream")), raise_on_hard_error=True)
    assert record.entry_type == "unknown"
    assert record.notes.startswith("Raw OCR text:")


class _Message:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.message = _Message(content)


class _Response:
    def __init__(self, content):
        self.choices = [_Choice(content)]


class _ChatReturns:
    def __init__(self, content):
        self.content = content

    def parse(self, **kwargs):
        return _Response(self.content)


class _ClientOK:
    def __init__(self, content):
        self.chat = _ChatReturns(content)


def test_llm_extract_preserves_antibody_prefix():
    import json

    payload = {
        "entry_type": "blood_test",
        "biomarkers": [
            {"name": "anti-Opisthorchis IgG", "value": "отрицат.", "unit": "",
             "standard_name_en": "Opisthorchis IgG"},
            {"name": "anti-Lamblia IgA+IgM+IgG", "value": "отрицат.", "unit": "",
             "standard_name_en": "Anti-Giardia IgA+IgM+IgG"},
            {"name": "anti-CCP", "value": "5", "unit": "",
             "standard_name_en": "Anti-CCP antibodies"},
            {"name": "Гемоглобин", "value": "130", "unit": "",
             "standard_name_en": "Hemoglobin"},
        ],
    }
    record = llm_extract("markdown", _ClientOK(json.dumps(payload)))
    by_name = {b.name: b.standard_name_en for b in record.biomarkers}
    assert by_name["anti-Opisthorchis IgG"] == "anti-Opisthorchis IgG"
    assert by_name["anti-Lamblia IgA+IgM+IgG"] == "anti-Giardia IgA+IgM+IgG"
    assert by_name["anti-CCP"] == "anti-CCP antibodies"
    assert by_name["Гемоглобин"] == "Hemoglobin"


class _SeqClient:
    def __init__(self, contents):
        self.contents = list(contents)
        self.calls = 0
        self.chat = self

    def parse(self, **kwargs):
        self.calls += 1
        return _Response(self.contents.pop(0))


_MARKDOWN_WITH_NUMBERS = (
    "Рекомендовано:\n"
    "1. Рациональное питание\n"
    "2. Лабораторная диагностика\n"
    "3. Повторный осмотр с результатами дообследований\n"
)


def _visit_json(recs):
    import json

    return json.dumps({"entry_type": "doctor_visit",
                       "visit_data": {"recommendations": recs}})


def test_llm_extract_retries_when_numbered_recommendation_missing():
    first = _visit_json(["1. Рациональное питание", "2. Лабораторная диагностика"])
    complete = _visit_json(["1. Рациональное питание", "2. Лабораторная диагностика",
                            "3. Повторный осмотр с результатами дообследований"])
    client = _SeqClient([first, complete])
    record = llm_extract(_MARKDOWN_WITH_NUMBERS, client)
    assert client.calls == 2
    assert len(record.visit_data.recommendations) == 3


def test_llm_extract_no_retry_when_complete():
    complete = _visit_json(["1. Рациональное питание", "2. Лабораторная диагностика",
                            "3. Повторный осмотр с результатами дообследований"])
    client = _SeqClient([complete])
    record = llm_extract(_MARKDOWN_WITH_NUMBERS, client)
    assert client.calls == 1
    assert len(record.visit_data.recommendations) == 3


def test_llm_extract_keeps_first_when_retry_not_better():
    first = _visit_json(["1. Рациональное питание", "2. Лабораторная диагностика"])
    client = _SeqClient([first, first])
    record = llm_extract(_MARKDOWN_WITH_NUMBERS, client)
    assert client.calls == 2
    assert len(record.visit_data.recommendations) == 2


def test_llm_extract_retries_json_parse_failure_then_succeeds():
    import json

    payload = json.dumps({"entry_type": "blood_test", "biomarkers": []})
    client = _SeqClient(["definitely not json", payload])
    record = llm_extract("markdown", client)
    assert client.calls == 2
    assert record.entry_type == "blood_test"


def test_llm_extract_json_parse_failure_twice_falls_back():
    client = _SeqClient(["not json", "still not json"])
    record = llm_extract("markdown", client)
    assert client.calls == 2
    assert record.entry_type == "unknown"
    assert record.notes.startswith("Raw OCR text:")


def test_llm_extract_parse_retry_provider_error_falls_back():
    class _ParseThenProviderError:
        def __init__(self):
            self.calls = 0
            self.chat = self

        def parse(self, **kwargs):
            self.calls += 1
            if self.calls == 1:
                return _Response("not json")
            raise _Err("500 upstream", 500)

    client = _ParseThenProviderError()
    record = llm_extract("markdown", client)
    assert client.calls == 2
    assert record.entry_type == "unknown"
