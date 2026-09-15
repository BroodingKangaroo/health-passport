"""Import-jobs API: submit documents for background extraction, poll them,
and manage their lifecycle (cancel / retry / dismiss).

Design (docs/batch-import-tickets.md):
- Quota is CHARGED at submit (same helpers as /api/extract) and refunded on
  failure/cancel by the worker or the CAS cancel transition — never on
  client disconnect (there is none for a batch submit).
- Storage quota is NOT charged at submit — staged files only cost storage
  when the reviewed entry saves (A5). The per-user pending cap (config)
  bounds the uncharged-storage worst case: its staged-bytes check counts
  every job still holding a file (queued/processing/done/dismissed).
- All lifecycle mutations are CAS transitions: the worker owns anything it
  dequeued (API cancel only FLAGS a processing job); retry re-charges only
  via the winning failed->queued transition.
- Dismiss keeps the staged file + result of a done-extraction so it can be
  restored (POST .../restore, CAS dismissed->done) within the GC TTL
  window; past the TTL the sweep frees the file (the row itself stays as
  PERMANENT history — earlier imports never disappear from the UI).
- The GC sweep runs lazily here (submit + list-read) — global, never
  caller-scoped.
"""

import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import func, update
from sqlalchemy.orm import Session

from app import i18n
from app.api.ai import MAX_EXTRACT_FILE_SIZE, _get_client
from app.api.auth import get_current_user_or_anon_strict
from app.db.models import (
    BiomarkerDefinition,
    BiomarkerReading,
    ExtractionJob,
    MedicalEntry,
    Notification,
    Patient,
)
from app.db.session import get_db
from app.i18n import tr_opt
from app.services import extract_jobs, extractor, upload_cleanup
from app.services.extract_jobs import record_funnel_event
from app.services.upload_cleanup import unlink_unreferenced_files, unlink_upload_file
from app.services.usage_limits import check_and_record_ai_usage, refund_ai_extraction
from config import IMPORT_JOB_TTL_H, IMPORT_PENDING_MAX_JOBS, IMPORT_PENDING_MAX_STAGED_MB

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/import")


def _localized_error(job: ExtractionJob) -> Optional[str]:
    """Resolve a stored error_key (+ params) against the request locale —
    the worker thread had none when it recorded the failure."""
    if not job.error_key:
        return None
    params = job.error_params or {}
    try:
        resolved = tr_opt(job.error_key, **params)
    except (KeyError, ValueError):
        return job.error_key
    # A catalog key removed/renamed since the failure was recorded must still
    # render text; the raw key is the diagnostic fallback (never null).
    return resolved if resolved is not None else job.error_key


def _job_restorable(job: ExtractionJob) -> bool:
    """A dismissed done-extraction is restorable only while the restore
    window is open: within the GC TTL AND with its staged file still on disk
    (the sweep frees the file after the TTL — that is what ends the window;
    the dismissed row itself stays visible as permanent history)."""
    if job.status != "dismissed" or job.result is None or not job.file_size:
        return False
    if job.updated_at is not None:
        cutoff = (
            datetime.now(timezone.utc).replace(tzinfo=None)
            - timedelta(hours=IMPORT_JOB_TTL_H)
        )
        if job.updated_at < cutoff:
            return False
    path = extract_jobs._staged_full_path(job.file_path)
    return bool(path and os.path.isfile(path))


def _job_summary(job: ExtractionJob) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "stage": job.stage or "",
        "progress": job.progress,
        "original_filename": job.original_filename,
        "file_size": job.file_size,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "error": _localized_error(job) if job.status == "failed" else None,
        # Restore eligibility (see _job_restorable).
        "restorable": _job_restorable(job),
        "merge_conflicts": [],
        # The entry a saved job produced (history rows), surfaced so the
        # tracker can link back to the timeline entry.
        "saved_entry_id": job.saved_entry_id,
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


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _merge_overlap_conflicts(
    db: Session, user_id: str, jobs: list[ExtractionJob]
) -> dict[str, list[str]]:
    """List-page merge pre-check: for each ``done`` blood-test job whose
    staged record carries a date, detect whether any same-date blood-test
    entry already contains one of the record's biomarkers. A non-empty list
    per job id means merging into that day's entry would be refused with a
    409 by ``POST /api/entry/{id}/merge`` — the tracker shows it as a
    warning so the user doesn't enter the review editor in vain (saving as a
    separate entry is still possible).

    Mirrors the merge conflict matching (``entries._detect_merge_conflicts``
    + the client's useMergePreflight): staged rows WITH a definition_id
    conflict by identifier equivalence (definition id <-> LOINC code, both
    directions); rows WITHOUT one (manual-typed) by display name —
    bidirectional containment on definition names (the server resolves
    manual rows with ILIKE '%name%' over names[en/es/de/fr/he]) and
    name-contained-in-synonym, so the pre-check never under-warns a merge
    that would 409 (it may over-warn for name languages the server ignores,
    e.g. names['ru']). Batched: one entries
    query for all dates, one readings query, one definitions query.

    Computed at LIST time (not persisted at done-time) so a warning can
    never outlive the entries it talks about — the extra queries only run
    when there are done blood-test jobs to check.
    """
    staged: list[tuple[ExtractionJob, str, list[dict]]] = []
    for j in jobs:
        if j.status != "done" or not j.result:
            continue
        rec = j.result
        if rec.get("entry_type") != "blood_test":
            continue
        date_str = str(rec.get("date") or "")
        if not _DATE_RE.match(date_str):
            continue
        biomarkers = rec.get("biomarkers") or []
        if not biomarkers:
            continue
        staged.append((j, date_str, biomarkers))
    if not staged:
        return {}

    dates = sorted({d for _, d, _ in staged})
    entries = (
        db.query(MedicalEntry)
        .filter(
            MedicalEntry.patient_id == user_id,
            MedicalEntry.type == "blood_test",
            func.date(MedicalEntry.date).in_(dates),
        )
        .all()
    )
    if not entries:
        return {}
    entry_ids = [e.id for e in entries]
    readings = (
        db.query(BiomarkerReading)
        .filter(BiomarkerReading.entry_id.in_(entry_ids))
        .all()
    )
    union_ids = {r.biomarker_id for r in readings}
    staged_def_ids = {
        str(b["definition_id"])
        for _, _, bms in staged
        for b in bms
        if b.get("definition_id")
    }
    lookup_ids = union_ids | staged_def_ids
    defns: list[BiomarkerDefinition] = []
    if lookup_ids:
        defns = (
            db.query(BiomarkerDefinition)
            .filter(
                (BiomarkerDefinition.id.in_(lookup_ids))
                | (BiomarkerDefinition.loinc_code.in_(lookup_ids))
            )
            .all()
        )
    defn_by_id = {d.id: d for d in defns}
    defn_by_loinc = {d.loinc_code: d for d in defns if d.loinc_code}

    # Per existing entry: expanded identifier keys + lowercase name/synonym
    # pools (same expansion as _detect_merge_conflicts) + its calendar day.
    per_entry: dict[str, tuple[set[str], set[str], list[str], str]] = {}
    for e in entries:
        keys: set[str] = set()
        names: set[str] = set()
        synonyms: list[str] = []
        for r in readings:
            if r.entry_id != e.id:
                continue
            keys.add(r.biomarker_id)
            d = defn_by_id.get(r.biomarker_id) or defn_by_loinc.get(r.biomarker_id)
            if d is None:
                continue
            keys.add(d.id)
            if d.loinc_code:
                keys.add(d.loinc_code)
            for v in (d.names or {}).values():
                names.add(str(v).strip().lower())
            synonyms.extend(str(s).strip().lower() for s in (d.synonyms or []))
        per_entry[e.id] = (keys, names, synonyms, str(e.date)[:10])

    out: dict[str, list[str]] = {}
    for j, date_str, biomarkers in staged:
        conflicts: list[str] = []
        seen: set[str] = set()
        for e in entries:
            keys, names, synonyms, day = per_entry[e.id]
            if day != date_str or (not keys and not names):
                continue
            for b in biomarkers:
                def_id = str(b.get("definition_id") or "")
                if def_id:
                    d = defn_by_id.get(def_id)
                    hit = def_id in keys or bool(
                        d is not None and d.loinc_code and d.loinc_code in keys
                    )
                else:
                    name = str(b.get("raw_name") or "").strip().lower()
                    # Bidirectional containment (the server's manual-row
                    # fallback is ILIKE '%name%': the stored name merely
                    # CONTAINS the row name) + synonym containment.
                    hit = bool(name) and (
                        any(name in nm or nm in name for nm in names)
                        or any(name in s for s in synonyms)
                    )
                if not hit:
                    continue
                display = str(b.get("raw_name") or b.get("standard_name_en") or "").strip()
                if display and display not in seen:
                    seen.add(display)
                    conflicts.append(display)
        if conflicts:
            out[j.id] = conflicts
    return out


@router.post("/jobs")
async def create_import_job(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon_strict),
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

    # Per-user pending cap: the JOB-COUNT cap counts concurrent work only
    # (queued/processing), while the staged-bytes cap counts every job still
    # holding a file (queued/processing/done/failed/dismissed — done files
    # are kept for restore, failed ones for retry), because staged files cost
    # no storage until the reviewed entry saves and this bounds the
    # uncharged-storage worst case.
    pending = (
        db.query(ExtractionJob)
        .filter(
            ExtractionJob.user_id == user_id,
            ExtractionJob.status.in_(["queued", "processing"]),
        )
        .all()
    )
    staged_holders = (
        db.query(func.coalesce(func.sum(ExtractionJob.file_size), 0))
        .filter(
            ExtractionJob.user_id == user_id,
            ExtractionJob.status.in_(
                ["queued", "processing", "done", "failed", "dismissed"]
            ),
        )
        .scalar()
    )
    staged_bytes = int(staged_holders or 0)
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

    logger.info(
        "Import job %s submitted (user %s, %d bytes, %s)",
        job.id, user_id, len(bytes_data), ext,
    )
    record_funnel_event(db, "submitted", user_id, is_anonymous)
    db.commit()
    extract_jobs.enqueue_job(job.id)
    # Lazy global GC: expired staged jobs/files (any user) leave here.
    # Best-effort — a transient sweep failure must not 500 a submit whose
    # job was already committed and enqueued.
    try:
        extract_jobs.sweep_expired_jobs()
    except Exception:
        logger.warning("Import-job GC sweep failed (submit path)", exc_info=True)
    return {"job_id": job.id}


@router.get("/jobs")
async def list_import_jobs(
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon_strict),
):
    _user, user_id, _is_anonymous = user_data
    # Lazy global GC on the list-read path too — best-effort, same rationale.
    try:
        extract_jobs.sweep_expired_jobs()
    except Exception:
        logger.warning("Import-job GC sweep failed (list path)", exc_info=True)
    rows = (
        db.query(ExtractionJob)
        .filter(ExtractionJob.user_id == user_id)
        .order_by(ExtractionJob.created_at.desc(), ExtractionJob.id.desc())
        .all()
    )
    summaries = [_job_summary(j) for j in rows]
    conflicts = _merge_overlap_conflicts(db, user_id, rows)
    for s in summaries:
        c = conflicts.get(s["id"])
        if c:
            s["merge_conflicts"] = c
    return {"items": summaries}


@router.get("/jobs/{job_id}")
async def get_import_job(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon_strict),
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


@router.get("/jobs/{job_id}/file")
async def download_import_job_file(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon_strict),
):
    """Serve the STAGED file to its owner (preview in the review editor).

    The /static/uploads route only authorizes files backed by an Attachment
    row — a staged job's file has none yet, so it needs its own tenant-scoped
    endpoint. Same stored-XSS headers as serve_upload (nosniff + attachment
    disposition): never rendered inline on the API origin; the frontend
    previews via fetch + blob object URLs, which are unaffected.
    """
    _user, user_id, _is_anonymous = user_data
    job = _own_job(db, job_id, user_id)
    full_path = extract_jobs._staged_full_path(job.file_path)
    if not full_path or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail=i18n.tr("main.file_not_found"))
    ext = os.path.splitext(full_path)[1].lower()
    from fastapi.responses import FileResponse

    att_name = job.original_filename or os.path.basename(full_path)
    ascii_name = re.sub(r"[^A-Za-z0-9 ._-]", "_", att_name).strip("_ ") or "document"
    quoted = quote(att_name)
    return FileResponse(
        full_path,
        # Single source of truth for uploadable types: submit validates
        # against ALLOWED_EXTENSIONS, so TIFF/BMP staged files preview with
        # their real blob type instead of octet-stream (generic card).
        media_type=extractor.MIME_MAP.get(ext, "application/octet-stream"),
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'
            ),
        },
    )


@router.post("/jobs/{job_id}/cancel")
async def cancel_import_job(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon_strict),
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
            logger.info("Import job %s cancelled while queued (user %s)", job.id, user_id)
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
        logger.info("Import job %s cancel requested while processing (user %s)", job.id, user_id)
        return {"job_id": job.id, "status": "processing", "cancel_requested": True}

    raise HTTPException(status_code=409, detail=i18n.tr("import.cancel_not_active"))


@router.post("/jobs/{job_id}/retry")
async def retry_import_job(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon_strict),
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
    logger.info("Import job %s retried after failure (user %s)", job.id, user_id)
    return {"job_id": job.id, "status": "queued"}


@router.post("/jobs/{job_id}/restore")
async def restore_import_job(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon_strict),
):
    """RESTORE a dismissed import — CAS ``dismissed -> done`` so a done
    extraction becomes reviewable again (re-enters the tracker's active list
    with Review available). Constraints:
    - only a job dismissed FROM done is restorable: ``result`` must be
      present (dismiss-from-queued/failed rows have no extracted data);
    - the restore WINDOW is the GC TTL (CAS on ``updated_at``) AND the
      staged file still existing — past it the sweep has freed the file
      (the dismissed row stays visible as history, just unrestorable);
    - the staged file is verified AFTER the winning CAS (mirroring the
      save-claim rollback): GC deletes the file only together with the
      window, so a missing file means the window is closed — the transition
      is rolled back instead of staging a ghost save;
    - the bell notification is recreated in the SAME commit (dismiss deleted
      it; the restored job must be reviewable from the bell again). No
      funnel event — the extraction is not re-run.
    """
    _user, user_id, _is_anonymous = user_data
    job = _own_job(db, job_id, user_id)
    if job.status != "dismissed":
        raise HTTPException(
            status_code=409, detail=i18n.tr("import.restore_not_dismissed")
        )
    if job.result is None:
        raise HTTPException(
            status_code=409, detail=i18n.tr("import.restore_not_reviewable")
        )

    cutoff = datetime.now(timezone.utc) - timedelta(hours=IMPORT_JOB_TTL_H)
    result = db.execute(
        update(ExtractionJob)
        .where(
            ExtractionJob.id == job.id,
            ExtractionJob.user_id == user_id,
            ExtractionJob.status == "dismissed",
            ExtractionJob.updated_at >= cutoff,
        )
        .values(status="done", stage="", updated_at=datetime.now(timezone.utc))
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=404, detail=i18n.tr("import.not_found"))
    full_path = extract_jobs._staged_full_path(job.file_path)
    if not full_path or not os.path.isfile(full_path):
        db.rollback()
        raise HTTPException(
            status_code=409, detail=i18n.tr("import.job_failed_file_missing")
        )
    extract_jobs.emit_job_notification(db, job, "import_job_done")
    db.commit()
    logger.info("Import job %s restored from dismissed (user %s)", job.id, user_id)
    return {"job_id": job.id, "status": "done"}


@router.delete("/jobs/{job_id}")
async def dismiss_import_job(
    job_id: str,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon_strict),
):
    """DISMISS an active job — a CAS transition into the ``dismissed`` state
    (the row is KEPT and shows in the tracker's history; it is not deleted):
    - queued -> dismissed: refund (the extraction never ran) + staged file
      freed (no result -> never restorable).
    - done -> dismissed: no refund (the extraction was consumed), notification
      rows deleted (the bell must never offer "Review" on a dismissed job);
      the staged file + result are KEPT so POST .../restore can revive the
      extraction within the GC TTL window; past the TTL the sweep frees the
      file (the dismissed row itself is PERMANENT history and never
      disappears).
    - failed -> dismissed: no refund (already refunded on the failure),
      staged file freed (no result -> never restorable).
    - processing: the worker owns the job — flag it like a cancel; it lands
      in history as ``cancelled`` when the worker honors the flag.
    - saved/cancelled/dismissed: 409 — the UI offers no dismiss there and
      saved history rows cannot be removed.
    The staged file and (for done) the result are deliberately KEPT: within
    the GC TTL window a done-extraction can be revived via POST .../restore;
    past the TTL the sweep deletes the dismissed row + its file together.
    """
    _user, user_id, _is_anonymous = user_data
    job = _own_job(db, job_id, user_id)

    if job.status in ("saved", "cancelled", "dismissed"):
        raise HTTPException(status_code=409, detail=i18n.tr("import.dismiss_not_terminal"))

    if job.status == "processing":
        db.execute(
            update(ExtractionJob)
            .where(ExtractionJob.id == job.id, ExtractionJob.status == "processing")
            .values(cancel_requested=True, updated_at=datetime.now(timezone.utc))
        )
        db.commit()
        logger.info("Import job %s dismiss requested while processing (user %s)", job.id, user_id)
        return {"job_id": job.id, "status": "processing", "cancel_requested": True}

    was_status = job.status
    values: dict = {
        "status": "dismissed",
        "stage": "",
        "progress": None,
        "updated_at": datetime.now(timezone.utc),
    }
    if was_status in ("queued", "failed"):
        # The file is freed below (no result -> never restorable) — stop
        # counting its bytes against the staged-bytes cap immediately.
        values["file_size"] = 0
    result = db.execute(
        update(ExtractionJob)
        .where(ExtractionJob.id == job.id, ExtractionJob.status == was_status)
        .values(**values)
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail=i18n.tr("import.dismiss_not_terminal"))
    db.query(Notification).filter(Notification.job_id == job.id).delete(
        synchronize_session=False
    )
    db.commit()
    if was_status == "queued":
        # Never ran — same refund rule as a queued cancel.
        refund_ai_extraction(db, user_id, bool(job.is_anonymous))
    # A dismissed-from-done job keeps its staged file + result so restore can
    # re-attach them within the GC TTL (the sweep is the other half of that
    # bargain, deleting row + file together). A dismissed-from-queued/failed
    # job can NEVER be restored (no result) nor retried (wrong status), so
    # its file would just deadweight the staged-bytes cap for the TTL — free
    # it right away (reference-checked: a saved job's file is an Attachment,
    # and dismiss 409s there anyway).
    if was_status in ("queued", "failed"):
        unlink_unreferenced_files(db, [job.file_path])
    logger.info(
        "Import job %s dismissed from %s (user %s)", job.id, was_status, user_id
    )
    return {"dismissed": True}
