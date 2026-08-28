"""Provider-split chat client: OpenAI-compatible chat via OpenRouter with
Mistral kept for OCR/Files.

Every LLM text call in the pipeline funnels through ``client.chat.parse(...)``
(extractor + matcher) with a pydantic ``response_format``; OCR is isolated in
``ocr_document`` (``client.files``/``client.ocr``). This module exploits that:

- ``OpenRouterChatClient.chat.parse(...)`` maps the Mistral SDK call shape onto
  an OpenAI-compatible ``/chat/completions`` POST (pydantic model → JSON
  schema; ``json_schema`` mode with a ``json_object`` retry when a model
  rejects schemas). It returns a Mistral-shaped response
  (``.choices[0].message.content`` is a JSON *string*) — every call site
  already handles string content, so no pipeline code changes.
- ``split_chat_client(mistral)`` wraps a real Mistral client so ``chat`` goes
  to OpenRouter while ``files``/``ocr`` (and everything else) delegate
  untouched — OCR stays Mistral.
- ``build_chat_aware_client()`` is the env switch used by ``app.api.ai`` and
  the benchmark: ``CHAT_PROVIDER=openrouter`` + ``OPENROUTER_API_KEY`` (+
  optional ``OPENROUTER_CHAT_MODEL`` override) enables the split; anything
  else returns the plain Mistral client (current behavior).

The benchmark's ``InstrumentedMistral`` wraps the hybrid transparently: it
intercepts ``chat``/``files``/``ocr`` namespaces on whatever object
``make_instrumented_client`` builds, so OpenRouter calls get the same
token/latency/pollution accounting as Mistral ones.
"""

import contextlib
import json
import logging
import os
import time
from types import SimpleNamespace
from typing import Any, Optional

import httpx
from pydantic import ValidationError

logger = logging.getLogger(__name__)

DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
# Per-call HTTP timeout and bounded retries for transient failures (429/5xx).
# The benchmark's pollution guard counts whatever still escapes.
CHAT_CALL_TIMEOUT_S = 300.0
CHAT_MAX_ATTEMPTS = 3
CHAT_RETRY_BACKOFF_S = 2.0


def _strip_code_fences(text: str) -> str:
    """Strip markdown ```json fences some open models wrap their JSON in."""
    s = text.strip()
    if s.startswith("```"):
        first_nl = s.find("\n")
        if first_nl != -1:
            s = s[first_nl + 1:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    return s.strip()


def _extract_json_object(text: str) -> str:
    """Pull the outermost JSON object out of a model reply.

    Handles fenced JSON, JSON embedded after reasoning chatter, and plain
    JSON. Raises RuntimeError when nothing parseable is present — the
    pipeline's per-call fallbacks (and the benchmark's pollution counters)
    then fire exactly as they do for an unparseable Mistral response.
    """
    s = _strip_code_fences(text)
    try:
        json.loads(s)
        return s
    except json.JSONDecodeError:
        pass
    start, end = s.find("{"), s.rfind("}")
    if start != -1 and end > start:
        candidate = s[start:end + 1]
        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError:
            pass
    raise RuntimeError(
        f"no valid JSON object in OpenRouter reply: {s[:200]!r}")


class OpenRouterChatClient:
    """OpenAI-compatible chat with Mistral-SDK ``.chat.parse`` semantics."""

    def __init__(self, api_key: str, model: str,
                 base_url: str = DEFAULT_OPENROUTER_BASE_URL,
                 fallback_models: Optional[list[str]] = None):
        self.api_key = api_key
        self.model = model
        # OpenRouter routes the request down this list on provider failure —
        # the built-in answer to volatile free shared pools. First entry is
        # also sent as `model` for compatibility.
        self.fallback_models = fallback_models or []
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(timeout=CHAT_CALL_TIMEOUT_S)

    def close(self):
        self._http.close()

    def _post(self, payload: dict) -> dict:
        resp = self._http.post(
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"OpenRouter HTTP {resp.status_code}: {resp.text[:500]}")
        return resp.json()

    def _chat_payload(self, messages, temperature, max_tokens,
                      response_format: dict) -> dict:
        payload: dict[str, Any] = {
            "model": self.model,
            "temperature": temperature,
            "messages": messages,
            "response_format": response_format,
        }
        if self.fallback_models:
            payload["models"] = [self.model, *self.fallback_models]
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        return payload

    def parse(self, model: str = "", temperature: float = 0.0,
              messages=None, response_format=None, max_tokens: Optional[int] = None,
              **_ignored):
        """Mistral-SDK-shaped structured chat call.

        ``model`` is accepted for call-site compatibility and remapped to the
        configured ``OPENROUTER_CHAT_MODEL``. ``response_format`` is a pydantic
        model class; the reply is returned as a Mistral-like namespace whose
        ``choices[0].message.content`` is a JSON *string* — call sites already
        handle string content.

        Token economy + conformance: the JSON schema is embedded in the
        system message on EVERY attempt — free-model providers routinely
        treat ``json_schema`` mode as advisory, and the prompt-side hint is
        what keeps them conforming (measured: without it GLM-5.2:free
        returns empty/invalid extractions). The adapter additionally
        validates the reply against the pydantic model itself and retries
        with ``json_object`` mode on non-conforming output; on success the
        content is the canonical (validated, compact) JSON — downstream
        parsing can't drift.
        """
        if response_format is None:
            raise ValueError("chat.parse requires a pydantic response_format")
        return self._attempt(messages or [], temperature, max_tokens,
                             response_format)

    def _attempt(self, messages, temperature, max_tokens, response_format):
        schema = response_format.model_json_schema()
        schema_rf = {"type": "json_schema", "json_schema": {
            "name": "response", "strict": False, "schema": schema}}
        object_rf = {"type": "json_object"}
        schema_hint = (
            "Return ONLY valid JSON matching exactly this JSON schema:\n"
            + json.dumps(schema)
        )
        # Schema hint on EVERY attempt: prompt-side conformance for providers
        # that don't enforce json_schema strictly.
        hint_messages = [dict(m) for m in messages]
        hint_messages[0] = {
            **hint_messages[0],
            "content": f"{hint_messages[0].get('content', '')}\n\n{schema_hint}",
        }
        last_err: Optional[Exception] = None
        for attempt in range(1, CHAT_MAX_ATTEMPTS + 1):
            use_object = attempt > 1
            try:
                data = self._post(self._chat_payload(
                    hint_messages, temperature, max_tokens,
                    object_rf if use_object else schema_rf))
            except RuntimeError as e:
                last_err = e
                transient = "HTTP 429" in str(e) or "HTTP 5" in str(e)
                schema_rejected = "HTTP 400" in str(e)
                if schema_rejected and attempt == 1:
                    continue  # json_object fallback, no sleep
                if not transient or attempt == CHAT_MAX_ATTEMPTS:
                    raise
                # Free shared pools recover in seconds-to-minutes: be patient.
                time.sleep(CHAT_RETRY_BACKOFF_S * 2 * attempt)
                continue
            message = data["choices"][0]["message"]
            raw_usage = data.get("usage") or {}
            usage = SimpleNamespace(
                prompt_tokens=raw_usage.get("prompt_tokens"),
                completion_tokens=raw_usage.get("completion_tokens"),
            )
            # Reasoning models may return empty content with the answer inside
            # `reasoning`; others may wrap/lead with chatter. content=None
            # (e.g. max_tokens exhausted mid-reasoning) must fail cleanly.
            text = message.get("content") or message.get("reasoning") or ""
            try:
                candidate = json.loads(_extract_json_object(text))
                response_format.model_validate(candidate)
            except (RuntimeError, ValidationError) as e:
                last_err = e
                continue  # retry with schema hint; final attempt falls through
            # Canonical compact JSON of the VALIDATED model: guaranteed to
            # parse downstream, minimal tokens, defaults filled.
            content = json.dumps(candidate, ensure_ascii=False,
                                 separators=(",", ":"))
            return SimpleNamespace(
                usage=usage,
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))],
            )
        # Exhausted: hand back the least-bad JSON candidate (if any) and let
        # the call site's existing fallback semantics apply — unless nothing
        # parseable ever came back, in which case raise (pollution-visible).
        if isinstance(last_err, ValidationError):
            text = ""
            with contextlib.suppress(RuntimeError, KeyError, TypeError):
                text = _extract_json_object(
                    data["choices"][0]["message"].get("content") or "")
            if text:
                return SimpleNamespace(
                    usage=SimpleNamespace(prompt_tokens=None, completion_tokens=None),
                    choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
                )
        raise last_err

    def __getattr__(self, name):
        # Mirror the Mistral client's attribute surface for anything the
        # pipeline might touch besides chat (defensive; OCR/files go through
        # the wrapped Mistral client instead).
        raise AttributeError(
            f"{type(self).__name__} only implements .chat (got .{name})")


class _HybridChatNamespace:
    """Routes .chat.parse per call type.

    ``scope="all"`` sends every chat call to the OpenAI-compatible client.
    ``scope="extraction"`` sends only the document-extraction call
    (``response_format=RawMedicalRecord`` — the big, expensive prompt) to
    OpenRouter and keeps everything else (name/unit/visit translation,
    verify/zero-shot) on the Mistral client — measured: GLM-class models
    match mistral-large on structured lab-table extraction but lose on
    free-text translation fidelity.
    """

    def __init__(self, chat_client: "OpenRouterChatClient",
                 mistral_client: Any, scope: str = "all"):
        from app.schemas.ai import RawMedicalRecord

        self._chat = chat_client
        self._mistral = mistral_client
        self._scope = scope
        self._extraction_formats = (RawMedicalRecord,)

    def parse(self, response_format=None, **kwargs):
        if response_format is None:
            raise ValueError("chat.parse requires a pydantic response_format")
        route_openrouter = self._scope == "all" or (
            response_format in self._extraction_formats)
        if route_openrouter:
            return self._chat.parse(response_format=response_format, **kwargs)
        return self._mistral.chat.parse(response_format=response_format, **kwargs)


class SplitChatClient:
    """Duck-typed Mistral client: chat routed per scope, everything else
    (files/ocr) stays Mistral.

    The benchmark's InstrumentedMistral and the pipeline only ever touch
    ``.chat``, ``.files`` and ``.ocr`` — the latter two delegate to the real
    Mistral client (OCR stays Mistral) regardless of scope.
    """

    def __init__(self, mistral_client: Any, chat_client: "OpenRouterChatClient",
                 scope: str = "all"):
        self._mistral = mistral_client
        self.chat = _HybridChatNamespace(chat_client, mistral_client, scope)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._mistral, name)


def build_chat_aware_client(mistral_client: Any) -> Any:
    """Env-gated provider split (default: unchanged plain-Mistral behavior).

    Returns a ``SplitChatClient`` when ``CHAT_PROVIDER=openrouter`` and
    ``OPENROUTER_API_KEY`` are configured; otherwise returns the Mistral
    client as-is. ``OPENROUTER_SCOPE`` (default ``all``) routes only the
    extraction call to OpenRouter when set to ``extraction``.
    """
    if (os.getenv("CHAT_PROVIDER", "").lower() != "openrouter"
            or not os.getenv("OPENROUTER_API_KEY")):
        return mistral_client
    model = os.getenv("OPENROUTER_CHAT_MODEL", "z-ai/glm-5.2:free")
    fallbacks = [m.strip() for m in os.getenv("OPENROUTER_CHAT_FALLBACKS", "").split(",")
                 if m.strip()]
    scope = os.getenv("OPENROUTER_SCOPE", "all").lower()
    chat = OpenRouterChatClient(
        os.environ["OPENROUTER_API_KEY"], model,
        base_url=os.getenv("OPENROUTER_BASE_URL", DEFAULT_OPENROUTER_BASE_URL),
        fallback_models=fallbacks)
    logger.info("Chat provider: OpenRouter model=%s scope=%s (OCR stays Mistral)",
                model, scope)
    return SplitChatClient(mistral_client, chat, scope)
