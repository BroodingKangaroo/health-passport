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
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, update
from sqlalchemy.orm import Session, sessionmaker

from app.api.ai import _get_client
from app.db.models import (
    BiomarkerDefinition,
    ExtractionJob,
    ImportFunnelEvent,
    Notification,
)
from app.db.session import DATABASE_URL
from app.schemas.ai import (
    RawInstrumentalData,
    StandardizedMedicalRecord,
    StandardizedVisitData,
)
from app.services import extractor, matcher, timing_stats
from app.services.language_detect import detect_source_language
from app.services.upload_cleanup import (
    _PATH_PREFIX,
    unlink_unreferenced_files,
    unlink_upload_file,
)
from app.services.usage_limits import refund_ai_extraction
from config import IMPORT_JOB_TTL_H, IMPORT_WORKERS

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
# ids; the daemon workers consume them. Threads start lazily on first
# enqueue.
job_queue: queue.Queue[str] = queue.Queue()

_workers_started = False
_workers_lock = threading.Lock()


def enqueue_job(job_id: str) -> None:
    job_queue.put(job_id)
    _ensure_workers()


def _ensure_workers() -> None:
    """Start the daemon worker threads on first enqueue (IMPORT_WORKERS of
    them; default 1 — serial Mistral calls, see config)."""
    global _workers_started
    with _workers_lock:
        if _workers_started:
            return
        for i in range(IMPORT_WORKERS):
            thread = threading.Thread(
                target=_worker_loop, args=(i,), name=f"import-worker-{i}", daemon=True
            )
            thread.start()
        _workers_started = True


def _worker_loop(worker_idx: int) -> None:
    while True:
        job_id = job_queue.get()
        try:
            process_job(job_id)
        except Exception:
            # process_job handles its own failures; a raise here would be a
            # bug — log it and keep the worker alive.
            logger.exception(
                "Import worker %d: unexpected error for job %s", worker_idx, job_id
            )
        finally:
            job_queue.task_done()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def record_funnel_event(db: Session, event: str, user_id: str, is_anonymous: bool) -> None:
    """Write one import-funnel counter row (submitted/extracted/saved/failed).

    Rides the caller's commit (the worker's terminal transition or the
    import API's submit commit). Cancelled jobs never write rows. Best-effort
    logging: a funnel failure must never break the extraction path.
    """
    try:
        db.add(ImportFunnelEvent(event=event, user_id=user_id, is_anonymous=is_anonymous))
    except Exception:
        logger.warning("Funnel event %s not recorded (user %s)", event, user_id, exc_info=True)


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
    - ``saving`` rows: a save-with-job-id crashed mid-commit — restore to
      ``done`` (no refund — the extraction succeeded; the file is still
      staged and reviewable).

    Called from the app lifespan, after ``assert_single_process``. Returns a
    small summary for the startup log.
    """
    db = get_sessionmaker()()
    summary = {"failed": 0, "requeued": 0, "restored": 0}
    refunds: list[tuple[str, bool]] = []
    try:
        # A crash mid-save leaves the CAS claim ("saving") — the save rolled
        # back, so the staged job is still valid: restore it to done.
        restored = db.execute(
            update(ExtractionJob)
            .where(ExtractionJob.status == "saving")
            .values(status="done")
        )
        summary["restored"] = restored.rowcount
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
    if summary["failed"] or summary["requeued"] or summary["restored"]:
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

    ``saved`` history rows never expire (they are tiny — the result payload
    is cleared on save — and the staged file is by then the entry's
    Attachment, so nothing can leak).
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
        # ``saving`` rows are CAS claims of an in-flight save-with-job-id —
        # never swept, or the staged file could be unlinked mid-save.
        # ``saved`` rows are history records — never swept.
        expired = (
            db.query(ExtractionJob)
            .filter(
                ExtractionJob.updated_at < cutoff,
                ExtractionJob.status.not_in(["saving", "saved"]),
            )
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


# +++++ Worker pipeline (A2) +++++


class _JobCancelled(Exception):
    """Internal: raised at a stage boundary when the user requested cancel
    while the job was already processing (worker-owned cancel path)."""


def _staged_full_path(file_path: str) -> str:
    """On-disk path of a staged job file from its stored web path
    (``/static/uploads/<name>``), mirroring upload_cleanup's traversal
    guards. Returns "" for anything outside the uploads directory."""
    if not file_path or not file_path.startswith(_PATH_PREFIX):
        return ""
    filename = file_path[len(_PATH_PREFIX):]
    if not filename or ".." in filename or filename.startswith("/"):
        return ""
    return os.path.join(upload_cleanup_upload_dir(), filename)


def upload_cleanup_upload_dir() -> str:
    """UPLOAD_DIR read at call time (tests monkeypatch the module attr)."""
    from app.services import upload_cleanup

    return upload_cleanup.UPLOAD_DIR


def _claim_job(db: Session, job_id: str) -> bool:
    """CAS ``queued -> processing``: the worker owns everything it dequeues.
    Loses the race when the API cancel transitioned the job meanwhile."""
    result = db.execute(
        update(ExtractionJob)
        .where(ExtractionJob.id == job_id, ExtractionJob.status == "queued")
        .values(status="processing", stage="", updated_at=_utcnow())
    )
    db.commit()
    return result.rowcount == 1


def _set_stage(db: Session, job_id: str, stage: str, progress: dict) -> None:
    """Persist one stage transition so the tracker/batch UI mirrors the SSE
    progress payloads. Committed immediately — the job list is polled live."""
    db.execute(
        update(ExtractionJob)
        .where(ExtractionJob.id == job_id)
        .values(stage=stage, progress=progress)
    )
    db.commit()


def _raise_if_cancel_requested(db: Session, job_id: str) -> None:
    flagged = (
        db.query(ExtractionJob.cancel_requested)
        .filter(ExtractionJob.id == job_id)
        .scalar()
    )
    if flagged:
        raise _JobCancelled()


def _refund(db: Session, user_id: str, is_anonymous: bool) -> None:
    try:
        refund_ai_extraction(db, user_id, is_anonymous)
    except Exception:
        logger.warning("Import-job quota refund failed (user %s)", user_id, exc_info=True)


def _finalize_done(db: Session, job: ExtractionJob, result_dump: dict) -> None:
    # The terminal write commits the match stage's definition writes too —
    # the documented commit-before-close invariant for the worker session.
    db.execute(
        update(ExtractionJob)
        .where(ExtractionJob.id == job.id, ExtractionJob.status == "processing")
        .values(
            status="done",
            stage="",
            result=result_dump,
            progress=None,
            updated_at=_utcnow(),
        )
    )
    emit_job_notification(db, job, "import_job_done")
    record_funnel_event(db, "extracted", job.user_id, bool(job.is_anonymous))
    db.commit()


def _finalize_failed(db: Session, job: ExtractionJob, error_key: str, error_params: dict | None) -> None:
    db.execute(
        update(ExtractionJob)
        .where(ExtractionJob.id == job.id, ExtractionJob.status == "processing")
        .values(
            status="failed",
            stage="",
            error_key=error_key,
            error_params=error_params,
            progress=None,
            updated_at=_utcnow(),
        )
    )
    emit_job_notification(db, job, "import_job_failed")
    record_funnel_event(db, "failed", job.user_id, bool(job.is_anonymous))
    db.commit()
    _refund(db, job.user_id, bool(job.is_anonymous))


def _finalize_cancelled(db: Session, job: ExtractionJob) -> None:
    db.execute(
        update(ExtractionJob)
        .where(ExtractionJob.id == job.id, ExtractionJob.status == "processing")
        .values(
            status="cancelled",
            stage="",
            progress=None,
            cancel_requested=False,
            updated_at=_utcnow(),
        )
    )
    db.commit()  # cancelled emits no notification
    _refund(db, job.user_id, bool(job.is_anonymous))
    # The worker owns the staged file on cancel — nothing will claim it.
    unlink_upload_file(job.file_path, upload_cleanup_upload_dir())


def process_job(job_id: str) -> None:
    """Run one import job end-to-end. Synchronous; the daemon workers call
    this from the queue. Never raises (unexpected errors land on the job's
    ``failed`` status so the worker loop can never die)."""
    db = get_sessionmaker()()
    try:
        if not _claim_job(db, job_id):
            # GC'd, already cancelled by the API, or vanished — nothing to do.
            return
        job = db.query(ExtractionJob).filter(ExtractionJob.id == job_id).first()
        try:
            _run_pipeline(db, job)
        except _JobCancelled:
            db.rollback()
            _finalize_cancelled(db, job)
        except Exception as e:
            db.rollback()
            logger.error("Import job %s failed: %s", job_id, e, exc_info=True)
            _finalize_failed(
                db,
                job,
                "import.job_failed_generic",
                {"error": str(e)[:300]},
            )
    finally:
        db.close()


def _run_pipeline(db: Session, job: ExtractionJob) -> None:
    """The /api/extract stages (ai.py), re-run against the job row: OCR ->
    LLM extraction -> source-language detection -> matcher (worker's own
    session, commit-before-close) -> staged ``result``. Progress mirrors the
    SSE payloads; quota is refunded on failure/cancel, never on success."""
    job_id = job.id
    user_id = job.user_id
    client = _get_client()
    if client is None:
        _finalize_failed(db, job, "ai.sse_no_mistral_key", {})
        return

    full_path = _staged_full_path(job.file_path)
    ext = os.path.splitext(job.original_filename or job.file_path)[1].lower()
    try:
        with open(full_path, "rb") as f:
            bytes_data = f.read()
    except OSError:
        logger.error("Import job %s: staged file missing at %s", job_id, full_path)
        _finalize_failed(db, job, "import.job_failed_file_missing", {})
        return

    # Stage 1: OCR
    _set_stage(db, job_id, "ocr_scanning", {"stage": "ocr_scanning"})
    _raise_if_cancel_requested(db, job_id)
    t0 = time.perf_counter()
    markdown = None
    error_key: str | None = None
    error_params: dict | None = None
    try:
        markdown = extractor.ocr_document(bytes_data, ext, client)
    except extractor.OCRProcessingError as ocr_err:
        # Classification ran in this thread without a request locale — store
        # the catalog key, resolved via i18n at read time (same pattern as
        # ai.py localizing from `kind`).
        if ocr_err.kind == "auth":
            error_key, error_params = "ai.ocr_auth", {
                "status": getattr(ocr_err, "http_status", "401/403")
            }
        else:
            error_key, error_params = f"ai.ocr_{ocr_err.kind}", {}
    else:
        elapsed = time.perf_counter() - t0
        logger.info(
            "Job %s: OCR took %.2fs — %d chars", job_id, elapsed, len(markdown) if markdown else 0
        )
        timing_stats.record(timing_stats.STAGE_OCR, elapsed)

    if error_key is None and not markdown:
        error_key, error_params = "ai.sse_no_text", {}
    if error_key:
        _finalize_failed(db, job, error_key, error_params)
        return

    _raise_if_cancel_requested(db, job_id)

    # Stage 2: LLM extraction
    _set_stage(
        db, job_id, "extracting",
        {
            "stage": "extracting",
            "markdown_chars": len(markdown),
            "estimate_s": round(timing_stats.estimate(timing_stats.STAGE_EXTRACT, len(markdown)), 1),
        },
    )
    t0 = time.perf_counter()
    raw = extractor.llm_extract(markdown, client)
    elapsed = time.perf_counter() - t0
    bm_count = len(raw.biomarkers) if raw.biomarkers else 0
    logger.info(
        "Job %s: extraction took %.2fs — type: %s, biomarkers: %d",
        job_id, elapsed, raw.entry_type, bm_count,
    )
    timing_stats.record(timing_stats.STAGE_EXTRACT, elapsed, len(markdown))
    source_language = detect_source_language(markdown)

    _raise_if_cancel_requested(db, job_id)

    # entry_type "unknown" is a SUCCESS (mirrors the SSE path): the LLM
    # genuinely ran and the user gets the unknown-editor. No refund.
    if raw.entry_type == "unknown":
        result = StandardizedMedicalRecord(
            entry_type="unknown",
            date=raw.date,
            time=raw.time,
            clinic=raw.clinic,
            provider=raw.provider,
            title=raw.title,
            notes=raw.notes,
            source_language=source_language,
            biomarkers=[],
            visit_data=StandardizedVisitData(),
            instrumental_data=RawInstrumentalData(),
        )
        _finalize_done(db, job, result.model_dump())
        return

    # Stage 3: matching (worker's own session; commit-before-close is the
    # terminal write below — definitions anchored here must survive close).
    _set_stage(
        db, job_id, "matching",
        {
            "stage": "matching",
            "biomarker_count": bm_count,
            "estimate_s": round(timing_stats.estimate(timing_stats.STAGE_MATCH), 1),
        },
    )
    t0 = time.perf_counter()
    definitions = db.query(BiomarkerDefinition).filter(
        (BiomarkerDefinition.scope == "global")
        | (BiomarkerDefinition.user_id == user_id)
        | (BiomarkerDefinition.user_id.is_(None))
    ).all()
    definitions.sort(key=lambda d: (d.category or "", d.names.get("en", "") or ""))
    result = matcher.match_and_convert(raw, definitions, db, user_id, client)
    elapsed = time.perf_counter() - t0
    logger.info(
        "Job %s: matching took %.2fs — biomarkers: %d",
        job_id, elapsed, len(result.biomarkers) if result.biomarkers else 0,
    )
    timing_stats.record(timing_stats.STAGE_MATCH, elapsed)
    result.source_language = source_language
    _finalize_done(db, job, result.model_dump())
