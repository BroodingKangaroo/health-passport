"""Import-jobs API: submit documents for background extraction, poll them,
and manage their lifecycle (cancel / retry / dismiss).

Design (docs/batch-import-tickets.md):
- Quota is CHARGED at submit (same helpers as /api/extract) and refunded on
  failure/cancel by the worker or the CAS cancel transition — never on
  client disconnect (there is none for a batch submit).
- Storage quota is NOT charged at submit — staged files only cost storage
  when the reviewed entry saves (A5). The per-user pending cap (config)
  bounds the uncharged-storage worst case.
- All lifecycle mutations are CAS transitions: the worker owns anything it
  dequeued (API cancel only FLAGS a processing job); retry re-charges only
  via the winning failed->queued transition.
- The GC sweep runs lazily here (submit + list-read) — global, never
  caller-scoped.
"""

import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import update
from sqlalchemy.orm import Session

from app import i18n
from app.api.ai import MAX_EXTRACT_FILE_SIZE, _get_client
from app.api.auth import get_current_user_or_anon
from app.db.models import ExtractionJob, Notification, Patient
from app.db.session import get_db
from app.i18n import tr_opt
from app.services import extract_jobs, extractor, upload_cleanup
from app.services.upload_cleanup import unlink_upload_file
from app.services.usage_limits import check_and_record_ai_usage, refund_ai_extraction
from config import IMPORT_PENDING_MAX_JOBS, IMPORT_PENDING_MAX_STAGED_MB

router = APIRouter(prefix="/api/import")


def _localized_error(job: ExtractionJob) -> Optional[str]:
    """Resolve a stored error_key (+ params) against the request locale —
    the worker thread had none when it recorded the failure."""
    if not job.error_key:
        return None
    params = job.error_params or {}
    try:
        return tr_opt(job.error_key, **params)
    except (KeyError, ValueError):
        return job.error_key


def _job_summary(job: ExtractionJob) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "stage": job.stage or "",
        "progress": job.progress,
        "original_filename": job.original_filename,
        "file_size": job.file_size,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "error": _localized_error(job) if job.status == "failed" else None,
    }


def _own_job(db: Session, job_id: str, user_id: str) -> ExtractionJob:
    job = (
        db.query(ExtractionJob)
        .filter(ExtractionJob.id == job_id, ExtractionJob.user_id == user_id)
        .first()
    )
    if job is None:
        # Foreign / unknown / expired-and-swept id — tenant-scoped 404.
        raise HTTPException(status_code=404, detail=i18n.tr("import.not_found"))
    return job


@router.post("/jobs")
async def create_import_job(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, is_anonymous = user_data
    if not file.filename:
        raise HTTPException(status_code=400, detail=i18n.tr("ai.no_filename"))

    # A job can never succeed without the key — reject before charging
    # (mirrors the SSE path resolving the client before quota).
    if _get_client() is None:
        raise HTTPException(
            status_code=503, detail=i18n.tr("ai.sse_no_mistral_key")
        )

    # Same validation as /api/extract.
    try:
        bytes_data = await extractor.read_capped(file, MAX_EXTRACT_FILE_SIZE)
    except extractor.FileTooLargeError as e:
        raise HTTPException(
            status_code=413,
            detail=i18n.tr(
                "ai.file_too_large",
                kb=e.size // 1024,
                max_mb=MAX_EXTRACT_FILE_SIZE // (1024 * 1024),
            ),
        ) from None
    except Exception as e:
        raise HTTPException(status_code=400, detail=i18n.tr("ai.read_file_failed", error=e)) from e
    if not bytes_data:
        raise HTTPException(status_code=400, detail=i18n.tr("ai.empty_file"))
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in extractor.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=i18n.tr(
                "ai.unsupported_file_type",
                ext=ext,
                allowed=", ".join(sorted(extractor.ALLOWED_EXTENSIONS)),
            ),
        )

    # Charge quota (deferred commit — a later step failing must not burn it).
    allowed, current_count, limit = check_and_record_ai_usage(db, user_id, is_anonymous, commit=False)
    if not allowed:
        if is_anonymous:
            detail = i18n.tr("ai.extraction_limit_anon", current=current_count, limit=limit)
        else:
            detail = i18n.tr("ai.extraction_limit_registered", current=current_count, limit=limit)
        raise HTTPException(status_code=429, detail=detail)

    # Per-user pending cap (concurrent non-terminal jobs + staged bytes) —
    # staged files cost no storage until the reviewed entry saves, so this
    # bounds the uncharged-storage worst case.
    pending = (
        db.query(ExtractionJob)
        .filter(
            ExtractionJob.user_id == user_id,
            ExtractionJob.status.in_(["queued", "processing"]),
        )
        .all()
    )
    staged_bytes = sum(j.file_size or 0 for j in pending)
    if len(pending) >= IMPORT_PENDING_MAX_JOBS:
        db.rollback()
        raise HTTPException(
            status_code=429,
            detail=i18n.tr("import.pending_cap", limit=IMPORT_PENDING_MAX_JOBS),
        )
    if staged_bytes + len(bytes_data) > IMPORT_PENDING_MAX_STAGED_MB * 1024 * 1024:
        db.rollback()
        raise HTTPException(
            status_code=429,
            detail=i18n.tr("import.pending_cap_storage", limit_mb=IMPORT_PENDING_MAX_STAGED_MB),
        )

    # Persist the staged file (uuid name, same web-path convention as
    # Attachment.file_path so save-with-job-id can adopt it directly).
    os.makedirs(upload_cleanup.UPLOAD_DIR, exist_ok=True)
    saved_name = f"{uuid.uuid4().hex}{ext}"
    with open(os.path.join(upload_cleanup.UPLOAD_DIR, saved_name), "wb") as f:
        f.write(bytes_data)
    file_path = f"/static/uploads/{saved_name}"

    job = ExtractionJob(
        id=extract_jobs.new_job_id(),
        user_id=user_id,
        is_anonymous=is_anonymous,
        status="queued",
        stage="",
        original_filename=file.filename,
        file_path=file_path,
        file_size=len(bytes_data),
    )
    db.add(job)
    db.commit()

    extract_jobs.enqueue_job(job.id)
    # Lazy global GC: expired staged jobs/files (any user) leave here.
    extract_jobs.sweep_expired_jobs()
    return {"job_id": job.id}


@router.get("/jobs")
async def list_import_jobs(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, _is_anonymous = user_data
    # Lazy global GC on the list-read path too.
    extract_jobs.sweep_expired_jobs()
    rows = (
        db.query(ExtractionJob)
        .filter(ExtractionJob.user_id == user_id)
        .order_by(ExtractionJob.created_at.desc(), ExtractionJob.id.desc())
        .all()
    )
    return {"items": [_job_summary(j) for j in rows]}


@router.get("/jobs/{job_id}")
async def get_import_job(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, _is_anonymous = user_data
    job = _own_job(db, job_id, user_id)
    payload = _job_summary(job)
    # Same shape as the SSE result event -> the review editor's form-fill
    # code consumes it unchanged.
    payload["result"] = job.result if job.status == "done" else None
    payload["error_key"] = job.error_key
    payload["error_params"] = job.error_params
    payload["updated_at"] = job.updated_at.isoformat() if job.updated_at else None
    return payload


@router.post("/jobs/{job_id}/cancel")
async def cancel_import_job(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """CAS transitions only: a QUEUED job is cancelled (refunded, file
    deleted) by the winning UPDATE; a PROCESSING job belongs to the worker —
    flag it and let the worker perform the refund/file cleanup between
    stages. Never refunds a non-queued job directly."""
    _user, user_id, _is_anonymous = user_data
    job = _own_job(db, job_id, user_id)

    if job.status == "queued":
        result = db.execute(
            update(ExtractionJob)
            .where(ExtractionJob.id == job.id, ExtractionJob.status == "queued")
            .values(status="cancelled", stage="", progress=None, updated_at=datetime.now(timezone.utc))
        )
        db.commit()
        if result.rowcount == 1:
            refund_ai_extraction(db, user_id, bool(job.is_anonymous))
            unlink_upload_file(job.file_path)
            return {"job_id": job.id, "status": "cancelled"}
        # Lost the race — the worker just claimed it; fall through to flag.
        job = _own_job(db, job_id, user_id)

    if job.status == "processing":
        db.execute(
            update(ExtractionJob)
            .where(ExtractionJob.id == job.id, ExtractionJob.status == "processing")
            .values(cancel_requested=True, updated_at=datetime.now(timezone.utc))
        )
        db.commit()
        return {"job_id": job.id, "status": "processing", "cancel_requested": True}

    raise HTTPException(status_code=409, detail=i18n.tr("import.cancel_not_active"))


@router.post("/jobs/{job_id}/retry")
async def retry_import_job(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """CAS failed->queued: re-charge quota atomically with the winning
    transition; the LLM genuinely runs again. Rejects non-failed jobs and a
    missing staged file (the extraction would be doomed)."""
    _user, user_id, is_anonymous = user_data
    job = _own_job(db, job_id, user_id)
    if job.status != "failed":
        raise HTTPException(status_code=409, detail=i18n.tr("import.retry_not_failed"))

    full_path = extract_jobs._staged_full_path(job.file_path)
    if not full_path or not os.path.isfile(full_path):
        raise HTTPException(
            status_code=400, detail=i18n.tr("import.job_failed_file_missing")
        )

    # Atomic pair: CAS transition + deferred quota charge in ONE commit.
    # If either loses (another retry won, or quota exhausted), nothing
    # changed.
    result = db.execute(
        update(ExtractionJob)
        .where(ExtractionJob.id == job.id, ExtractionJob.status == "failed")
        .values(
            status="queued",
            stage="",
            progress=None,
            error_key=None,
            error_params=None,
            cancel_requested=False,
            updated_at=datetime.now(timezone.utc),
        )
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail=i18n.tr("import.retry_not_failed"))
    allowed, current_count, limit = check_and_record_ai_usage(db, user_id, is_anonymous, commit=False)
    if not allowed:
        db.rollback()
        if is_anonymous:
            detail = i18n.tr("ai.extraction_limit_anon", current=current_count, limit=limit)
        else:
            detail = i18n.tr("ai.extraction_limit_registered", current=current_count, limit=limit)
        raise HTTPException(status_code=429, detail=detail)
    db.commit()

    extract_jobs.enqueue_job(job.id)
    return {"job_id": job.id, "status": "queued"}


@router.delete("/jobs/{job_id}")
async def dismiss_import_job(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """Dismiss a terminal job (done/failed/cancelled): delete the staged
    file, the row, and ALL its notification rows (retries can have produced
    several). Done jobs the user never saves disappear from the tracker this
    way; queued/processing jobs must be cancelled first."""
    _user, user_id, _is_anonymous = user_data
    job = _own_job(db, job_id, user_id)
    if job.status not in ("done", "failed", "cancelled"):
        raise HTTPException(status_code=409, detail=i18n.tr("import.dismiss_not_terminal"))
    file_path = job.file_path
    db.query(Notification).filter(Notification.job_id == job.id).delete(
        synchronize_session=False
    )
    db.delete(job)
    db.commit()
    unlink_upload_file(file_path)
    return {"dismissed": True}
