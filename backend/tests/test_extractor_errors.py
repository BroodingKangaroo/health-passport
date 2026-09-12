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
