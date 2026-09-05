"""Background import-jobs service (batch import with staged extraction).

Architecture (docs/batch-import-tickets.md):
- One ``ExtractionJob`` row per uploaded document; the extracted record is
  staged in the row (``result``) and only becomes a real entry when the user
  reviews and saves it. Staged jobs/files expire (``sweep_expired_jobs``).
- A module-level ``queue.Queue`` + daemon worker threads (A2) re-run the
  ``/api/extract`` pipeline. The queue is per-process: a startup guard
  (``assert_single_process``) fails loudly when a second app process targets
  the same DB, and boot recovery (``recover_orphan_jobs``) handles rows
  orphaned by a restart.
- ``SessionLocal`` injection seam: the worker must use the app's sessionmaker
  rather than a hardcoded global so tests can point it at the per-test
  in-memory engine (``tests/conftest.py`` overrides ``get_db``, not globals).

Refund authority: only the worker refunds a job it has dequeued; API-side
cancel/retry refund/charge only via CAS status transitions. Startup recovery
refunds the orphaned ``processing`` rows it fails (the worker that owned them
died with the old process and can never refund them itself).
"""

from __future__ import annotations

import logging
import os
import queue
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, update
from sqlalchemy.orm import Session, sessionmaker

from app.db.models import ExtractionJob, Notification
from app.db.session import DATABASE_URL
from app.services.upload_cleanup import unlink_unreferenced_files
from app.services.usage_limits import refund_ai_extraction
from config import IMPORT_JOB_TTL_H

logger = logging.getLogger(__name__)

# Sessionmaker injection seam (see module docstring). ``set_sessionmaker`` is
# called by tests; production uses the app's ``SessionLocal`` (imported
# lazily so tests that ``set_sessionmaker`` before first use never touch the
# file-backed engine).
_sessionmaker: sessionmaker | None = None


def set_sessionmaker(sm: sessionmaker) -> None:
    global _sessionmaker
    _sessionmaker = sm


def get_sessionmaker() -> sessionmaker:
    if _sessionmaker is not None:
        return _sessionmaker
    from app.db.session import SessionLocal

    return SessionLocal


# In-memory job queue (per-process by design — guarded at startup). Holds job
# ids; the daemon workers (A2) consume it. Threads start lazily on first
# enqueue.
job_queue: queue.Queue[str] = queue.Queue()


def enqueue_job(job_id: str) -> None:
    job_queue.put(job_id)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_job_id() -> str:
    return uuid.uuid4().hex


def emit_job_notification(db: Session, job: ExtractionJob, type_: str) -> None:
    """Insert the notification row for a job terminal transition.

    Called in the SAME commit as the job status change (worker terminal
    transitions and boot recovery). Exactly one row per transition; cancelled
    jobs emit nothing (callers never invoke this for them).
    """
    db.add(
        Notification(
            id=uuid.uuid4().hex,
            user_id=job.user_id,
            job_id=job.id,
            type=type_,
            payload={"job_id": job.id, "filename": job.original_filename},
        )
    )


def fail_orphan_processing(db: Session, job_id: str) -> bool:
    """CAS ``processing -> failed`` for one orphaned job. Returns True on the
    winning transition (caller then emits the notification + refunds)."""
    result = db.execute(
        update(ExtractionJob)
        .where(ExtractionJob.id == job_id, ExtractionJob.status == "processing")
        .values(
            status="failed",
            stage="",
            error_key="import.job_failed_interrupted",
            error_params=None,
        )
    )
    return result.rowcount == 1


def recover_orphan_jobs() -> dict:
    """Startup recovery for rows orphaned by a process restart.

    - ``processing`` rows: the worker that owned them died with the old
      process, so CAS-fail them, emit the failed notification, and refund the
      charged quota (a user who left during a crash must still learn the
      document failed).
    - ``queued`` rows: the in-memory queue died with the old process —
      re-enqueue into the fresh queue, otherwise they would sit "waiting"
      until GC with quota burned.

    Called from the app lifespan, after ``assert_single_process``. Returns a
    small summary for the startup log.
    """
    db = get_sessionmaker()()
    summary = {"failed": 0, "requeued": 0}
    refunds: list[tuple[str, bool]] = []
    try:
        orphans = (
            db.query(ExtractionJob)
            .filter(ExtractionJob.status.in_(["processing", "queued"]))
            .all()
        )
        for job in orphans:
            if job.status == "processing":
                if fail_orphan_processing(db, job.id):
                    emit_job_notification(db, job, "import_job_failed")
                    refunds.append((job.user_id, bool(job.is_anonymous)))
                    summary["failed"] += 1
            else:
                enqueue_job(job.id)
                summary["requeued"] += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    # Refund after the status change is committed (refund_ai_extraction
    # commits its own UPDATE); exactly once per orphaned processing row.
    for user_id, is_anonymous in refunds:
        try:
            refund_ai_extraction(get_sessionmaker()(), user_id, is_anonymous)
        except Exception:
            logger.warning(
                "Startup recovery: quota refund failed for user %s", user_id,
                exc_info=True,
            )
    if summary["failed"] or summary["requeued"]:
        logger.info("Import-job startup recovery: %s", summary)
    return summary


def sweep_expired_jobs(db: Session | None = None) -> int:
    """Global GC sweep: delete staged jobs older than ``IMPORT_JOB_TTL_H``
    (``updated_at`` — retries/progress keep a live job fresh), their staged
    files (via ``unlink_unreferenced_files``) and their notification rows
    (the bell must never offer "Review" on a 404'd job).

    Never caller-scoped: always sweeps EVERY user's expired rows, so a dead
    user's files cannot linger. Quota is refunded for non-terminal jobs
    (queued/processing) whose work never delivered a result; ``done`` jobs
    legitimately consumed their extraction, ``failed``/``cancelled`` were
    already refunded on their own transitions.

    Returns the number of jobs removed. Callers (import API) invoke this
    lazily on enqueue + list-read — no scheduler.
    """
    cutoff = _utcnow() - timedelta(hours=IMPORT_JOB_TTL_H)
    own_db = db is None
    if own_db:
        db = get_sessionmaker()()
    expired = []
    refunds: list[tuple[str, bool]] = []
    file_paths: list[str] = []
    freed = 0
    try:
        expired = (
            db.query(ExtractionJob)
            .filter(ExtractionJob.updated_at < cutoff)
            .all()
        )
        if expired:
            expired_ids = [j.id for j in expired]
            file_paths = [j.file_path for j in expired]
            refunds = [
                (j.user_id, bool(j.is_anonymous))
                for j in expired
                if j.status in ("queued", "processing")
            ]
            db.execute(
                delete(Notification).where(Notification.job_id.in_(expired_ids))
            )
            for job in expired:
                db.delete(job)
            db.commit()
            # After the rows are gone: the staged file is unreferenced (no
            # Attachment row ever points at a staged job file) — unlink it.
            freed = unlink_unreferenced_files(db, file_paths)
    except Exception:
        db.rollback()
        raise
    finally:
        if own_db:
            db.close()
    if not expired:
        return 0
    for user_id, is_anonymous in refunds:
        try:
            refund_ai_extraction(get_sessionmaker()(), user_id, is_anonymous)
        except Exception:
            logger.warning(
                "Expired-job quota refund failed for user %s", user_id, exc_info=True
            )
    logger.info(
        "Import-job GC: removed %d expired jobs, freed %d bytes", len(expired), freed
    )
    return len(expired)


_JOB_LOCK_FILENAME = ".job-worker.pid"


def _pid_file_path() -> str | None:
    """Path of the job-worker pid file (next to the SQLite DB file), or None
    when the guard does not apply (non-sqlite / in-memory DB)."""
    if not DATABASE_URL.startswith("sqlite"):
        return None
    db_path = DATABASE_URL.partition("sqlite:///")[2]
    if not db_path or db_path == ":memory:":
        return None
    # "sqlite:////abs/path" keeps a leading slash; "sqlite:///relative" does not.
    return os.path.join(os.path.dirname(db_path) or ".", _JOB_LOCK_FILENAME)


def assert_single_process() -> None:
    """Register this process as the sole job-worker owner (pid-file check).

    The queue is per-process: a second app process against the same DB would
    have worker-B "recovering" rows worker-A is processing. That is a
    misconfiguration and must fail loudly. A stale pid file (dead pid) means
    the previous process died without cleanup — take over.
    """
    path = _pid_file_path()
    if path is None:
        return
    pid: int = 0
    if os.path.isfile(path):
        try:
            with open(path) as f:
                pid = int(f.read().strip() or 0)
        except (OSError, ValueError):
            pid = 0
    if pid and pid != os.getpid():
        alive: bool | None
        try:
            os.kill(pid, 0)
            alive = True
        except ProcessLookupError:
            alive = False
        except PermissionError:
            alive = True  # exists, owned by another user
        except OSError:
            alive = None
        if alive is not False:
            raise RuntimeError(
                f"Job worker already running (pid {pid}, pid-file {path}). "
                "The import queue is per-process — run only ONE backend "
                "process per database (uvicorn --workers N / scaled "
                "containers are unsupported; see backend/docs/architecture.md)."
            )
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        f.write(str(os.getpid()))
