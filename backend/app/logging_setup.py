"""Process-wide logging configuration and request context.

Application logs go to BOTH stdout (so `docker logs` / the dev terminal see
them) and a rotating ``app.log`` file for local tailing. Every record carries
the current user/job context — empty when unset — plus the emitting thread
name, so worker and executor logs are joinable to the request that
triggered them.

The context lives in ContextVars, which do NOT propagate into
``run_in_executor`` calls or raw ``threading.Thread`` workers: those set the
context explicitly at their entry points.
"""

import logging
import sys
from contextvars import ContextVar
from logging.handlers import RotatingFileHandler
from typing import Any, Optional

_LOG_FORMAT = (
    "%(asctime)s [%(levelname)s] %(name)s [%(threadName)s]%(log_context)s: %(message)s"
)
_APP_LOG_FILE = "app.log"
_MAX_BYTES = 5 * 1024 * 1024
_BACKUP_COUNT = 3

_log_user: ContextVar[str] = ContextVar("log_user", default="")
_log_job: ContextVar[str] = ContextVar("log_job", default="")

_configured = False


def set_log_user(user_id: Optional[str]) -> None:
    _log_user.set(user_id or "")


def set_log_job(job_id: Optional[str]) -> None:
    _log_job.set(job_id or "")


def log_context() -> str:
    """Human-readable suffix (``" [user=... job=...]"``) for log messages."""
    parts = []
    user = _log_user.get()
    job = _log_job.get()
    if user:
        parts.append(f"user={user}")
    if job:
        parts.append(f"job={job}")
    return (" [" + " ".join(parts) + "]") if parts else ""


class _ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.log_context = log_context()
        return True


def setup_logging() -> None:
    global _configured
    if _configured:
        return
    _configured = True

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    formatter = logging.Formatter(_LOG_FORMAT)
    context_filter = _ContextFilter()

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(formatter)
    stream.addFilter(context_filter)

    file_handler = RotatingFileHandler(
        _APP_LOG_FILE, maxBytes=_MAX_BYTES, backupCount=_BACKUP_COUNT, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(context_filter)

    root.addHandler(stream)
    root.addHandler(file_handler)


class LogContextMiddleware:
    """Pure-ASGI middleware: logs unhandled request exceptions with
    method/path/user and re-raises so Starlette's own error handling is
    unchanged. Never wraps or buffers the response body — SSE streams pass
    through untouched (same rationale as LocaleMiddleware)."""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        except Exception:
            logging.getLogger("app.request").error(
                "Unhandled error on %s %s",
                scope.get("method", ""),
                scope.get("path", ""),
                exc_info=True,
            )
            raise
