"""Mistral client instrumentation for the extraction benchmark.

Wraps a ``Mistral`` client so every LLM call, OCR request and Files-API
upload is counted (calls, tokens, bytes) without touching the production
pipeline — the wrapper only observes and delegates. The benchmark passes the
instrumented client everywhere the real one would go; all pipeline code takes
the client as an argument, so nothing else changes.

Token fields follow the installed Mistral SDK: chat completions expose
``usage.prompt_tokens`` / ``usage.completion_tokens`` (NOT input/output), and
OCR responses expose ``usage_info.pages_processed`` /
``usage_info.doc_size_bytes``.
"""

import contextlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Callable, Optional

# Hard per-call watchdog. The Mistral SDK's read-timeout only counts between
# received bytes, so a server that keeps the socket half-open (periodic
# keepalive chunks, stalled stream) can block a call FOREVER — observed twice
# on overnight runs (process 0% CPU, DB frozen for ~1h). The watchdog converts
# such a stall into a TimeoutError the pipeline already handles like any other
# LLM failure. A timed-out worker thread is abandoned holding that client's
# pooled HTTP connections; to keep later calls from blocking forever on pool
# acquire, every timeout POISONS the current client and the next intercepted
# call transparently rebuilds a fresh one with identical settings.
CALL_TIMEOUT_S = 420.0

_watchdog_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="mistral-call")


def _call_with_watchdog(fn: Callable, on_timeout: Callable[[], None], *args, **kwargs):
    future = _watchdog_pool.submit(fn, *args, **kwargs)
    try:
        return future.result(timeout=CALL_TIMEOUT_S)
    except FutureTimeoutError:
        future.cancel()
        with contextlib.suppress(Exception):
            on_timeout()
        raise TimeoutError(
            f"Mistral call exceeded {CALL_TIMEOUT_S:.0f}s hard watchdog — treating as failure"
        ) from None


def _int_or_zero(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


class BenchmarkMetrics:
    """Mutable accumulator for one verification run.

    Counters are additive across the whole run (all cases); per-case metrics
    are the caller's job (start one record per case / swap the instrumented
    client's record when needed).
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.llm_calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.llm_latency_s = 0.0
        self.upload_bytes = 0
        self.uploads = 0
        self.ocr_calls = 0
        self.ocr_pages = 0
        self.ocr_doc_bytes = 0
        # stage name -> cumulative seconds
        self.stage_seconds: dict[str, float] = {}

    def add_llm_call(self, prompt_tokens: int, completion_tokens: int, latency_s: float):
        with self._lock:
            self.llm_calls += 1
            self.prompt_tokens += prompt_tokens
            self.completion_tokens += completion_tokens
            self.llm_latency_s += latency_s

    def add_upload(self, nbytes: int):
        with self._lock:
            self.uploads += 1
            self.upload_bytes += max(0, nbytes)

    def add_ocr(self, pages: int, doc_bytes: int):
        with self._lock:
            self.ocr_calls += 1
            self.ocr_pages += max(0, pages)
            self.ocr_doc_bytes += max(0, doc_bytes)

    def record_stage(self, name: str, seconds: float):
        with self._lock:
            self.stage_seconds[name] = self.stage_seconds.get(name, 0.0) + seconds

    def merge(self, other: "BenchmarkMetrics"):
        """Add another record into this one (e.g. per-run -> totals)."""
        with self._lock, other._lock:
            self.llm_calls += other.llm_calls
            self.prompt_tokens += other.prompt_tokens
            self.completion_tokens += other.completion_tokens
            self.llm_latency_s += other.llm_latency_s
            self.upload_bytes += other.upload_bytes
            self.uploads += other.uploads
            self.ocr_calls += other.ocr_calls
            self.ocr_pages += other.ocr_pages
            self.ocr_doc_bytes += other.ocr_doc_bytes
            for k, v in other.stage_seconds.items():
                self.stage_seconds[k] = self.stage_seconds.get(k, 0.0) + v

    def to_dict(self) -> dict:
        return {
            "llm_calls": self.llm_calls,
            "input_tokens": self.prompt_tokens,
            "output_tokens": self.completion_tokens,
            "upload_bytes": self.upload_bytes,
            "uploads": self.uploads,
            "ocr_calls": self.ocr_calls,
            "ocr_pages": self.ocr_pages,
            "ocr_doc_bytes": self.ocr_doc_bytes,
            "llm_latency_s": round(self.llm_latency_s, 3),
            "stage_seconds": {k: round(v, 3) for k, v in sorted(self.stage_seconds.items())},
        }


class _ChatNamespace:
    """Counts ``chat.parse`` calls (every LLM call site goes through it)."""

    def __init__(self, provider, poison, metrics: BenchmarkMetrics):
        self._provider = provider
        self._poison = poison
        self._metrics = metrics

    def parse(self, **kwargs):
        t0 = time.perf_counter()
        resp = _call_with_watchdog(self._provider().parse, self._poison, **kwargs)
        dt = time.perf_counter() - t0
        usage = getattr(resp, "usage", None)
        self._metrics.add_llm_call(
            _int_or_zero(getattr(usage, "prompt_tokens", None)),
            _int_or_zero(getattr(usage, "completion_tokens", None)),
            dt,
        )
        return resp

    def __getattr__(self, name):
        return getattr(self._provider(), name)


class _FilesNamespace:
    """Counts Files-API upload byte sizes (the OCR payload)."""

    def __init__(self, provider, poison, metrics: BenchmarkMetrics):
        self._provider = provider
        self._poison = poison
        self._metrics = metrics

    def upload(self, file=None, **kwargs):
        content = getattr(file, "content", None)
        if content is not None:
            self._metrics.add_upload(len(content))
        return _call_with_watchdog(self._provider().upload, self._poison, file=file, **kwargs)

    def __getattr__(self, name):
        return getattr(self._provider(), name)


class _OcrNamespace:
    """Counts OCR pages/document bytes from the response's ``usage_info``."""

    def __init__(self, provider, poison, metrics: BenchmarkMetrics):
        self._provider = provider
        self._poison = poison
        self._metrics = metrics

    def process(self, **kwargs):
        resp = _call_with_watchdog(self._provider().process, self._poison, **kwargs)
        info = getattr(resp, "usage_info", None)
        if info is not None:
            self._metrics.add_ocr(
                _int_or_zero(getattr(info, "pages_processed", None)),
                _int_or_zero(getattr(info, "doc_size_bytes", None)),
            )
        else:
            self._metrics.add_ocr(0, 0)
        return resp

    def __getattr__(self, name):
        return getattr(self._provider(), name)


class InstrumentedMistral:
    """Delegate/proxy around a Mistral client that feeds ``BenchmarkMetrics``.

    Only the three namespaces the pipeline uses (``chat``, ``files``, ``ocr``)
    are intercepted; everything else transparently forwards to the wrapped
    client via attribute delegation.

    Watchdog safety — see module docstring of ``_call_with_watchdog``: any
    watchdog timeout poisons the live client; namespaces consult the provider
    per call, so the next call transparently gets a rebuilt client.
    """

    def __init__(self, build_client, metrics: BenchmarkMetrics):
        # Accept either a ready client instance or a zero-arg builder
        # (tests pass fakes directly; make_instrumented_client passes the
        # lazy ``_get_client`` builder for poison/rebuild support).
        if not callable(build_client):
            ready = build_client
            build_client = lambda: ready  # noqa: E731
        self._build_client = build_client
        self._metrics = metrics
        self._client: Optional[object] = None
        self.chat = _ChatNamespace(lambda: self._ensure().chat, self._poison, metrics)
        self.files = _FilesNamespace(lambda: self._ensure().files, self._poison, metrics)
        self.ocr = _OcrNamespace(lambda: self._ensure().ocr, self._poison, metrics)

    @property
    def metrics(self) -> BenchmarkMetrics:
        return self._metrics

    def _ensure(self):
        if self._client is None:
            self._client = self._build_client()
        return self._client

    def _poison(self):
        self._client = None

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._ensure(), name)


def make_instrumented_client(metrics: BenchmarkMetrics):
    """Build a real Mistral client with production retry/timeout semantics
    (reuses ``app.api.ai._get_client``) wrapped in instrumentation.

    Requires ``MISTRAL_API_KEY`` in the environment (the caller validates it).
    """
    from app.api.ai import _get_client  # lazy import keeps module import cheap

    wrapper = InstrumentedMistral(_get_client, metrics)
    if wrapper._ensure() is None:
        raise RuntimeError("MISTRAL_API_KEY not configured")
    return wrapper
