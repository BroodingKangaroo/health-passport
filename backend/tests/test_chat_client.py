"""Offline unit tests for the provider-split chat client (OpenRouter chat,
Mistral OCR/files). No network: httpx I/O is faked at the _post seam."""

import json
from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from app.services.chat_client import (
    OpenRouterChatClient,
    SplitChatClient,
    _extract_json_object,
    _strip_code_fences,
    build_chat_aware_client,
)


class _Out(BaseModel):
    name: str
    value: int


def _ok_body(content: str, prompt_tokens: int = 11, completion_tokens: int = 7) -> dict:
    return {
        "choices": [{"message": {"content": content}}],
        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens},
    }


def _make_client(scripted):
    """Client with a scripted _post seam; records every payload."""
    client = OpenRouterChatClient("sk-test", "test/free-model")
    calls = []

    def fake_post(payload):
        calls.append(payload)
        step = scripted.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    client._post = fake_post
    return client, calls


# ------------------------------------------------------------ parse happy ---

def test_parse_maps_call_shape_and_returns_string_content():
    client, calls = _make_client([_ok_body('{"name": "Hemoglobin", "value": 1}')])
    resp = client.parse(
        model="mistral-large-latest",
        temperature=0,
        messages=[{"role": "system", "content": "sys"}, {"role": "user", "content": "usr"}],
        response_format=_Out,
        max_tokens=1234,
    )

    payload = calls[0]
    assert payload["model"] == "test/free-model"  # remapped, not mistral-large
    assert payload["temperature"] == 0
    assert payload["max_tokens"] == 1234
    rf = payload["response_format"]
    assert rf["type"] == "json_schema"
    assert rf["json_schema"]["schema"]["properties"]["name"]["type"] == "string"
    # Prompt-side schema hint rides along on every attempt: free providers
    # treat json_schema mode as advisory.
    assert "JSON schema" in payload["messages"][0]["content"]
    assert payload["messages"][1]["content"] == "usr"

    assert isinstance(resp.choices[0].message.content, str)
    parsed = json.loads(resp.choices[0].message.content)
    assert parsed == {"name": "Hemoglobin", "value": 1}
    assert resp.usage.prompt_tokens == 11 and resp.usage.completion_tokens == 7


def test_parse_strips_code_fences_and_canonicalizes():
    client, _ = _make_client([_ok_body('```json\n{"name": "x", "value": 2}\n```')])
    resp = client.parse(messages=[{"role": "system", "content": ""}],
                        response_format=_Out)
    # canonical compact JSON of the validated model
    assert json.loads(resp.choices[0].message.content) == {"name": "x", "value": 2}


# --------------------------------------------------- fallbacks and retries ---

def test_schema_rejection_falls_back_to_json_object(monkeypatch):
    monkeypatch.setattr("app.services.chat_client.CHAT_RETRY_BACKOFF_S", 0)
    client, calls = _make_client([
        RuntimeError("OpenRouter HTTP 400: schema not supported"),
        _ok_body('{"name": "y", "value": 3}'),
    ])
    resp = client.parse(messages=[{"role": "system", "content": "sys"}],
                        response_format=_Out)

    assert calls[0]["response_format"]["type"] == "json_schema"
    assert calls[1]["response_format"] == {"type": "json_object"}
    # The schema hint rides on both attempts; the fallback only switches
    # response_format to json_object.
    assert "JSON schema" in calls[0]["messages"][0]["content"]
    assert "JSON schema" in calls[1]["messages"][0]["content"]
    assert calls[1]["messages"][0]["content"].startswith("sys")
    assert json.loads(resp.choices[0].message.content)["value"] == 3


def test_transient_errors_retry_then_succeed(monkeypatch):
    monkeypatch.setattr("app.services.chat_client.CHAT_RETRY_BACKOFF_S", 0)
    client, calls = _make_client([
        RuntimeError("OpenRouter HTTP 503: busy"),
        RuntimeError("OpenRouter HTTP 429: rate limited"),
        _ok_body('{"name": "z", "value": 4}'),
    ])
    resp = client.parse(messages=[{"role": "system", "content": ""}],
                        response_format=_Out)
    assert len(calls) == 3
    assert json.loads(resp.choices[0].message.content)["value"] == 4


def test_persistent_failure_raises_for_pollution_guard(monkeypatch):
    monkeypatch.setattr("app.services.chat_client.CHAT_RETRY_BACKOFF_S", 0)
    client, calls = _make_client([
        RuntimeError("OpenRouter HTTP 503: busy") for _ in range(5)
    ])
    with pytest.raises(RuntimeError):
        client.parse(messages=[{"role": "system", "content": ""}],
                     response_format=_Out)
    assert len(calls) == 3  # bounded by CHAT_MAX_ATTEMPTS


# ------------------------------------------------------------- delegation ---

class _FakeMistral:
    def __init__(self):
        self.files = SimpleNamespace(upload=lambda **kw: "uploaded")
        self.ocr = SimpleNamespace(process=lambda **kw: "ocr'd")

    def models_list(self):
        return "passthrough"


def test_split_client_routes_chat_and_delegates_rest():
    chat_client, calls = _make_client([_ok_body('{"name": "a", "value": 1}')])
    mistral = _FakeMistral()
    hybrid = SplitChatClient(mistral, chat_client)

    assert hybrid.files.upload() == "uploaded"
    assert hybrid.ocr.process() == "ocr'd"
    assert hybrid.models_list() == "passthrough"

    resp = hybrid.chat.parse(
        model="mistral-large-latest",
        messages=[{"role": "system", "content": ""}],
        response_format=_Out,
    )
    assert calls[0]["model"] == "test/free-model"
    assert json.loads(resp.choices[0].message.content)["name"] == "a"


# ------------------------------------------------------------ env switch ---

def test_build_chat_aware_client_defaults_to_mistral(monkeypatch):
    monkeypatch.delenv("CHAT_PROVIDER", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("CHAT_FAILOVER", raising=False)
    mistral = _FakeMistral()
    assert build_chat_aware_client(mistral) is mistral


def test_failover_works_in_mistral_default_config(monkeypatch):
    """The storm scenario: CHAT_PROVIDER stays mistral, CHAT_FAILOVER arms the
    mistral→OpenRouter retry for EVERY call type (scope 'none')."""
    from app.schemas.ai import RawMedicalRecord, StandardizedVisitData

    monkeypatch.delenv("CHAT_PROVIDER", raising=False)
    monkeypatch.setenv("CHAT_FAILOVER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    monkeypatch.setenv("OPENROUTER_CHAT_MODEL", "test/free-model")

    mistral = _FakeMistral()
    hybrid = build_chat_aware_client(mistral)
    assert isinstance(hybrid, SplitChatClient)

    # healthy window: everything served by mistral, OpenRouter untouched
    healthy = _RecordingMistral()
    hybrid.chat._mistral = healthy
    ok_extraction = _ok_body(RawMedicalRecord(entry_type="unknown").model_dump_json())
    chat_client, calls = _make_client([ok_extraction])
    hybrid.chat._chat = chat_client
    hybrid.chat.parse(model="mistral-large-latest",
                      messages=[{"role": "system", "content": ""}],
                      response_format=RawMedicalRecord)
    assert len(healthy.chat_calls) == 1 and not calls

    # storm: mistral chat fails → GLM serves the same call
    failing = _FailingMistral()
    hybrid2 = build_chat_aware_client(failing)
    hybrid2.chat._chat = chat_client
    hybrid2.chat.parse(model="mistral-large-latest",
                       messages=[{"role": "system", "content": ""}],
                       response_format=StandardizedVisitData)
    assert len(failing.chat_calls) == 1 and len(calls) == 2  # OR retry
    import app.services.chat_client as cc
    assert cc.chat_failover_events() >= 1


def test_build_chat_aware_client_splits_on_env(monkeypatch):
    monkeypatch.setenv("CHAT_PROVIDER", "openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    monkeypatch.setenv("OPENROUTER_CHAT_MODEL", "test/free-model")
    mistral = _FakeMistral()
    hybrid = build_chat_aware_client(mistral)
    assert isinstance(hybrid, SplitChatClient)
    assert hybrid._mistral is mistral
    assert hybrid.chat._chat.model == "test/free-model"


# ---------------------------------------------------- per-call-type routing ---

class _RecordingMistral(_FakeMistral):
    def __init__(self):
        super().__init__()
        self.chat_calls = []
        self.chat = self

    def parse(self, **kwargs):
        self.chat_calls.append(kwargs)
        from pydantic import BaseModel

        class _Parsed(BaseModel):
            ping: str = "ok"
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=_Parsed().model_dump_json()))])


class _FailingMistral(_RecordingMistral):
    def parse(self, **kwargs):
        self.chat_calls.append(kwargs)
        raise RuntimeError("Mistral storm: read timeout")


def test_scope_extraction_routes_only_extraction_to_openrouter():
    from app.schemas.ai import RawMedicalRecord, StandardizedVisitData

    ok_extraction = _ok_body(RawMedicalRecord(entry_type="unknown").model_dump_json())
    chat_client, calls = _make_client([ok_extraction])
    mistral = _RecordingMistral()
    hybrid = SplitChatClient(mistral, chat_client, scope="extraction")

    # extraction call → OpenRouter
    hybrid.chat.parse(model="mistral-large-latest", messages=[{"role": "system", "content": ""}],
                      response_format=RawMedicalRecord, max_tokens=16000)
    assert len(calls) == 1 and not mistral.chat_calls

    # translation/matcher call → Mistral
    hybrid.chat.parse(model="mistral-large-latest", messages=[{"role": "system", "content": ""}],
                      response_format=StandardizedVisitData, max_tokens=16000)
    assert len(calls) == 1 and len(mistral.chat_calls) == 1
    assert mistral.chat_calls[0]["response_format"] is StandardizedVisitData
    assert mistral.chat_calls[0]["model"] == "mistral-large-latest"


def test_scope_all_keeps_legacy_behavior():
    from app.schemas.ai import StandardizedVisitData

    chat_client, calls = _make_client([_ok_body('{"ping": "x"}')])
    mistral = _RecordingMistral()
    hybrid = SplitChatClient(mistral, chat_client, scope="all")

    hybrid.chat.parse(messages=[{"role": "system", "content": ""}],
                      response_format=StandardizedVisitData)
    assert len(calls) == 1 and not mistral.chat_calls


# ------------------------------------------------- mistral→openrouter failover ---

def test_failover_retries_mistral_failure_on_openrouter():
    from app.schemas.ai import StandardizedVisitData

    chat_client, calls = _make_client([_ok_body('{"ping": "x"}')])
    mistral = _FailingMistral()
    hybrid = SplitChatClient(mistral, chat_client, scope="extraction",
                             failover=True)

    resp = hybrid.chat.parse(model="mistral-large-latest",
                             messages=[{"role": "system", "content": ""}],
                             response_format=StandardizedVisitData)

    # mistral attempted first, then the same call served by OpenRouter
    assert len(mistral.chat_calls) == 1
    assert len(calls) == 1
    assert resp.usage.prompt_tokens == 11
    import app.services.chat_client as cc
    assert cc.chat_failover_events() >= 1


def test_failover_disabled_propagates_mistral_failure():
    from app.schemas.ai import StandardizedVisitData

    chat_client, calls = _make_client([_ok_body('{"ping": "x"}')])
    mistral = _FailingMistral()
    hybrid = SplitChatClient(mistral, chat_client, scope="extraction",
                             failover=False)

    with pytest.raises(RuntimeError, match="Mistral storm"):
        hybrid.chat.parse(messages=[{"role": "system", "content": ""}],
                          response_format=StandardizedVisitData)
    assert not calls  # no OpenRouter attempt


def test_failover_extraction_route_unchanged():
    """OR-first routes never touch mistral, failover or not."""
    from app.schemas.ai import RawMedicalRecord

    chat_client, calls = _make_client(
        [_ok_body(RawMedicalRecord(entry_type="unknown").model_dump_json())])
    mistral = _FailingMistral()
    hybrid = SplitChatClient(mistral, chat_client, scope="extraction",
                             failover=True)

    hybrid.chat.parse(messages=[{"role": "system", "content": ""}],
                      response_format=RawMedicalRecord)
    assert len(calls) == 1 and not mistral.chat_calls


# --------------------------------------------------------------- fences ---

def test_strip_code_fences_variants():
    assert _strip_code_fences('{"a": 1}') == '{"a": 1}'
    assert _strip_code_fences('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert _strip_code_fences('```\n{"a": 1}\n```') == '{"a": 1}'
    assert _strip_code_fences('  {"a": 1}  ') == '{"a": 1}'


# --------------------------------------------- free-model robustness zoo ---

def test_reasoning_chatter_with_embedded_json_is_extracted():
    client, _ = _make_client([_ok_body(
        'We need to output JSON. The schema wants a name. So: {"name": "n", "value": 5}')])
    resp = client.parse(messages=[{"role": "system", "content": ""}],
                        response_format=_Out)
    assert json.loads(resp.choices[0].message.content) == {"name": "n", "value": 5}


def test_null_content_falls_back_to_reasoning_field():
    body = {"choices": [{"message": {"content": None,
                                     "reasoning": 'thinking... {"name": "r", "value": 6}'}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
    client, _ = _make_client([body])
    resp = client.parse(messages=[{"role": "system", "content": ""}],
                        response_format=_Out)
    assert json.loads(resp.choices[0].message.content)["value"] == 6


def test_nonconforming_reply_retries_with_hint_then_succeeds():
    """The GLM failure mode: valid JSON missing required fields under loose
    json_schema enforcement. Retry with json_object + schema hint fixes it."""
    client, calls = _make_client([
        _ok_body('{"value": 9}'),                       # missing "name"
        _ok_body('{"name": "n", "value": 9}'),
    ])
    resp = client.parse(messages=[{"role": "system", "content": "sys"}],
                        response_format=_Out)

    assert calls[0]["response_format"]["type"] == "json_schema"
    assert calls[1]["response_format"] == {"type": "json_object"}
    assert "JSON schema" in calls[1]["messages"][0]["content"]
    assert json.loads(resp.choices[0].message.content) == {"name": "n", "value": 9}


def test_persistently_nonconforming_reply_hands_back_best_json():
    client, _ = _make_client([_ok_body('{"value": 9}')] * 3)
    resp = client.parse(messages=[{"role": "system", "content": ""}],
                        response_format=_Out)
    # least-bad candidate returned; the call site's fallback semantics apply
    assert json.loads(resp.choices[0].message.content) == {"value": 9}


def test_no_json_anywhere_raises_cleanly():
    client, calls = _make_client([_ok_body("I cannot answer that.")] * 3)
    with pytest.raises(RuntimeError, match="no valid JSON"):
        client.parse(messages=[{"role": "system", "content": ""}],
                     response_format=_Out)
    assert len(calls) == 3


def test_extract_json_object_rejects_unparseable():
    with pytest.raises(RuntimeError):
        _extract_json_object("{broken")
