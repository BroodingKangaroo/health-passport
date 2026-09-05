import contextlib
import hashlib
import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Union

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from sqlalchemy import String, cast, func, or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import i18n
from app.api._serializers import definition_rank_order, definition_visibility
from app.api.auth import get_current_user_or_anon
from app.db.models import (
    Attachment as AttachmentModel,
)
from app.db.models import (
    BiomarkerDefinition as BiomarkerDefinitionModel,
)
from app.db.models import (
    BiomarkerReading,
    Patient,
)
from app.db.models import (
    ExtractionJob as ExtractionJobModel,
)
from app.db.models import (
    InstrumentalData as InstrumentalDataModel,
)
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
)
from app.db.models import (
    Notification as NotificationModel,
)
from app.db.models import (
    VisitData as VisitDataModel,
)
from app.db.session import get_db
from app.schemas import DeleteEntryResponse, EntriesByDateResponse, SaveEntryResponse
from app.services.extractor import ALLOWED_EXTENSIONS as ATTACHMENT_EXTENSIONS
from app.services.extractor import FileTooLargeError, read_capped
from app.services.language_detect import SUPPORTED_LANGUAGES
from app.services.reference import compute_status, merge_reference, normalize_qual, parse_value
from app.services.upload_cleanup import unlink_unreferenced_files, unlink_upload_file
from app.services.usage_limits import check_and_record_storage_usage
from config import IMPORT_JOB_TTL_H

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB


logger = logging.getLogger(__name__)


_LOINC_RE = re.compile(r"^\d+-\d+(\.\d+)?$")


def _is_loinc(code: Optional[str]) -> bool:
    return bool(code) and bool(_LOINC_RE.match(code))


def _escape_like(value: str) -> str:
    """Escape LIKE/ILIKE wildcards so a client-supplied name containing
    ``%`` or ``_`` matches literally instead of arbitrarily (ISSUES.md #56;
    use with ``ilike(..., escape="\\")``)."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


router = APIRouter()


def _normalize_date(date_str: str, time_str: str = "") -> datetime:
    if not date_str:
        raise ValueError("date is required")
    if time_str:
        dt = datetime.fromisoformat(f"{date_str}T{time_str}")
    else:
        dt = datetime.fromisoformat(date_str)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    # Already tz-aware: CONVERT to UTC instead of .replace(tzinfo=utc),
    # which clobbers the real offset (ISSUES.md #55 — safe only while
    # SQLite strips tzinfo, and wrong on any offset-preserving backend).
    return dt.astimezone(timezone.utc)


class _ReadingSpec:
    """A parsed, definition-resolved biomarker row, ready to be persisted as a
    BiomarkerReading. Shared by save_entry and the merge endpoint so the two
    never drift apart in semantics."""

    __slots__ = ("defn", "eff_ref", "result_value", "row", "status", "value_col", "value_text")

    def __init__(self, defn, value_col, value_text, result_value, eff_ref, status, row):
        self.defn = defn
        self.value_col = value_col
        self.value_text = value_text
        self.result_value = result_value
        self.eff_ref = eff_ref
        self.status = status
        self.row = row


def _resolve_definition(db: Session, user_id: str, name: str, row_defn_id: Optional[str], category: str, unit: str = "") -> BiomarkerDefinitionModel:
    """Resolve a form row to a BiomarkerDefinition. Order:
    1) by definition_id (or LOINC code, since the matcher emits LOINC as id);
    2) fuzzy by name against definitions visible to this user;
    3) create a per-user local definition.
    Mirrors the historical save_entry resolution chain exactly.
    Client-supplied ids are visibility-filtered (ISSUES.md #43): they must
    never resolve to another tenant's local definition."""
    defn = None
    if row_defn_id:
        defn = (
            db.query(BiomarkerDefinitionModel)
            .filter(
                BiomarkerDefinitionModel.id == row_defn_id,
                definition_visibility(user_id),
            )
            .first()
        )
        # Also resolve by LOINC code (the matcher emits LOINC as definition_id)
        if not defn and _is_loinc(row_defn_id):
            defn = (
                db.query(BiomarkerDefinitionModel)
                .filter(
                    BiomarkerDefinitionModel.loinc_code == row_defn_id,
                    definition_visibility(user_id),
                )
                .order_by(*definition_rank_order())
                .first()
            )

    # Fallback: fuzzy match by name using SQL ILIKE
    if not defn:
        # Escape LIKE wildcards (ISSUES.md #56): a client-supplied name
        # containing % or _ must match literally, not arbitrarily.
        name_lower = _escape_like(name.lower())
        # Only match definitions visible to this user: global,
        # system-shared (user_id IS NULL), or this user's own local
        # definitions. This prevents a user's reading from being
        # linked to another user's private local definition.
        ownership = definition_visibility(user_id)
        # Build OR conditions for names and synonyms
        defn = (
            db.query(BiomarkerDefinitionModel)
            .filter(
                or_(
                    func.lower(BiomarkerDefinitionModel.names['en'].as_string()).ilike(name_lower, escape="\\"),
                    func.lower(BiomarkerDefinitionModel.names['es'].as_string()).ilike(name_lower, escape="\\"),
                    func.lower(BiomarkerDefinitionModel.names['de'].as_string()).ilike(name_lower, escape="\\"),
                    func.lower(BiomarkerDefinitionModel.names['fr'].as_string()).ilike(name_lower, escape="\\"),
                    func.lower(BiomarkerDefinitionModel.names['he'].as_string()).ilike(name_lower, escape="\\"),
                ),
                ownership,
            )
            .first()
        )
        # Also check synonyms array
        if not defn:
            defn = (
                db.query(BiomarkerDefinitionModel)
                .filter(
                    func.lower(cast(BiomarkerDefinitionModel.synonyms, String)).ilike(f'%{name_lower}%', escape="\\"),
                    ownership,
                )
                .first()
            )

    # No match at all — create a local entry
    if not defn:
        # Per-user id so two users entering the same novel analyte
        # get isolated local definitions (and never collide on a
        # shared primary key, which would raise an unhandled 500).
        defn_id = f"local-{user_id}-{hashlib.md5(name.lower().encode()).hexdigest()[:12]}"
        existing = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.id == defn_id
        ).first()
        if existing:
            defn = existing
        else:
            defn = BiomarkerDefinitionModel(
                id=defn_id,
                loinc_code=row_defn_id if _is_loinc(row_defn_id) else None,
                names={"en": name},
                synonyms=[name],
                category=category,
                reference=None,
                unit=unit,
                scope="local",
                user_id=user_id,
            )
            # Recover from a concurrent insert via a SAVEPOINT, not a
            # session-wide rollback: save_entry has already flushed the entry
            # (and earlier rows' definitions) into this transaction, and a
            # full rollback would discard that pending work while the code
            # keeps going — with FK enforcement off the final commit would
            # then persist readings pointing at a nonexistent entry. The def
            # is added INSIDE the savepoint so a rollback expunges it instead
            # of leaving a zombie pending row that re-raises at the next flush.
            nested = db.begin_nested()
            db.add(defn)
            try:
                db.flush()
            except IntegrityError:
                nested.rollback()
                defn = db.query(BiomarkerDefinitionModel).filter(
                    BiomarkerDefinitionModel.id == defn_id
                ).first()
            else:
                nested.commit()
    return defn


def _parse_biomarker_rows(db: Session, user_id: str, categories_data: list) -> list[_ReadingSpec]:
    """Parse the form's biomarker categories into resolved reading specs.
    Rows without a name or an unparseable value are skipped."""
    specs: list[_ReadingSpec] = []
    for cat in categories_data:
        for row in cat.get("rows", []):
            name = row.get("name", "").strip()
            raw_value = row.get("value", "").strip()
            if not name or not raw_value:
                continue
            parsed = parse_value(raw_value)
            if parsed is None:
                continue
            if isinstance(parsed, (int, float)) and not isinstance(parsed, bool):
                value_col: Optional[float] = parsed
                value_text: Optional[str] = None
                result_value: Union[float, str, None] = parsed
            else:
                # Qualitative result — keep the text; previously these were
                # silently dropped because `value` was Float-only.
                value_col = None
                value_text = normalize_qual(parsed)
                result_value = value_text

            defn = _resolve_definition(db, user_id, name, row.get("definition_id"), cat.get("name", "General"), row.get("unit", ""))

            # Compose the effective reference: an explicit per-row reference
            # wins (document-first), a qualitative value forces qualitative,
            # otherwise fall back to the definition's reference.
            eff_ref = merge_reference(row.get("reference"), defn.reference, result_value)
            derived_status = compute_status(result_value, eff_ref)

            specs.append(_ReadingSpec(
                defn=defn,
                value_col=value_col,
                value_text=value_text,
                result_value=result_value,
                eff_ref=eff_ref,
                status=derived_status,
                row=row,
            ))
    return specs


def _create_reading_rows(
    db: Session,
    entry_id: str,
    specs: list[_ReadingSpec],
    merged: bool = False,
    merged_source: Optional[dict] = None,
) -> None:
    for spec in specs:
        db.add(BiomarkerReading(
            entry_id=entry_id,
            biomarker_id=spec.defn.id,
            value=spec.value_col,
            value_text=spec.value_text,
            reference=spec.eff_ref,
            status=spec.status,
            original_name=spec.row.get("original_name"),
            original_value=spec.row.get("original_value"),
            original_unit=spec.row.get("original_unit"),
            original_range=spec.row.get("original_range"),
            merged=merged,
            merged_source=merged_source,
        ))


def _build_visit_data_model(
    entry_id: str,
    vd: dict,
    title: str,
    provider: str,
    entry_date: datetime,
    clinic: str,
) -> VisitDataModel:
    """Translate the parsed visit_data JSON payload into a VisitDataModel row."""
    diagnosis = vd.get("diagnosis", {})
    chief_complaint = vd.get("chief_complaint", {})
    objective_findings = vd.get("objective_findings", {})

    def _get_tx(field, key):
        val = field.get(key) if isinstance(field, dict) else field
        return val if isinstance(val, str) else ""

    notes = []
    if chief_complaint.get("translated_en") or chief_complaint.get("original"):
        notes.append({
            "heading": "Chief Complaint & Subjective",
            "text_original": chief_complaint.get("original", ""),
            "text_translated": chief_complaint.get("translated_en", ""),
        })
    if objective_findings.get("translated_en") or objective_findings.get("original"):
        notes.append({
            "heading": "Objective Findings",
            "text_original": objective_findings.get("original", ""),
            "text_translated": objective_findings.get("translated_en", ""),
        })

    return VisitDataModel(
        entry_id=entry_id,
        specialty=title or "",
        provider=provider or "",
        date=entry_date,
        clinic=clinic or "",
        verdict={
            "original": _get_tx(diagnosis, "original"),
            "translated_en": _get_tx(diagnosis, "translated_en"),
        },
        notes=notes,
        prescriptions=[
            {
                "id": i + 1,
                "name": {
                    "original": _get_tx(rx.get("name", {}), "original"),
                    "translated_en": _get_tx(rx.get("name", {}), "translated_en"),
                },
                "dose": {
                    "original": _get_tx(rx.get("dosage", {}), "original"),
                    "translated_en": _get_tx(rx.get("dosage", {}), "translated_en"),
                },
                "instruction": {
                    "original": _get_tx(rx.get("instructions", {}), "original"),
                    "translated_en": _get_tx(rx.get("instructions", {}), "translated_en"),
                },
            }
            for i, rx in enumerate(vd.get("prescriptions", []))
        ],
        recommendations=[
            {
                "text_original": _get_tx(r, "original"),
                "text_translated": _get_tx(r, "translated_en"),
            }
            for r in vd.get("recommendations", [])
        ],
    )


def _build_instrumental_data_model(entry_id: str, idv: dict) -> InstrumentalDataModel:
    """Translate the parsed instrumental_data JSON payload into an
    InstrumentalDataModel row."""
    return InstrumentalDataModel(
        entry_id=entry_id,
        modality=str(idv.get("modality", "")),
        findings=str(idv.get("findings", "")),
        conclusion=str(idv.get("conclusion", "")),
    )


def _detect_merge_conflicts(db: Session, entry, specs: list[_ReadingSpec]) -> list[str]:
    """Return the display names of biomarkers already present in the target
    entry (by definition id OR LOINC code — a reading's biomarker_id may itself
    be a LOINC code from legacy ingestion, so both identifier forms are treated
    as equivalent). A non-empty result means the merge must be refused."""
    existing_ids = {r.biomarker_id for r in entry.biomarker_readings}
    existing_defns = (
        db.query(BiomarkerDefinitionModel)
        .filter(
            (BiomarkerDefinitionModel.id.in_(existing_ids))
            | (BiomarkerDefinitionModel.loinc_code.in_(existing_ids))
        )
        .all()
    )
    existing_keys = set(existing_ids)
    for d in existing_defns:
        existing_keys.add(d.id)
        if d.loinc_code:
            existing_keys.add(d.loinc_code)
    conflicts = []
    for spec in specs:
        defn = spec.defn
        if defn.id in existing_keys or (defn.loinc_code and defn.loinc_code in existing_keys):
            conflicts.append(spec.row.get("name") or (defn.names or {}).get("en") or defn.id)
    return conflicts


def _merged_source_from(
    title: str,
    clinic: str,
    provider: str,
    time: str,
    file: Optional[UploadFile],
) -> Optional[dict]:
    """Snapshot the merged upload's own metadata so the UI can describe the
    second test the readings came from. Only non-empty fields are kept. When
    the user left the title blank, fall back to the uploaded document's
    filename (sans extension) — far more informative than a generic "Blood
    Test Panel" placeholder."""
    source_title = title.strip()
    if not source_title and file and file.filename:
        source_title = os.path.splitext(os.path.basename(file.filename))[0]
    merged_source = {
        "title": source_title, "clinic": clinic, "provider": provider, "time": time,
    }
    return {k: v for k, v in merged_source.items() if v} or None


def _claim_staged_job(db: Session, job_id: str, user_id: str) -> ExtractionJobModel:
    """Validate + CAS-claim a staged import job for save/merge.

    The claim is a ``done -> saving`` transition inside the caller's (still
    uncommitted) transaction: it makes the GC sweep skip the row (sweeps
    never touch ``saving`` rows), so the staged file cannot be unlinked
    mid-save. Ownership, ``done`` status and the TTL are enforced by the
    same conditional UPDATE — anything else is a tenant-scoped 404. If the
    save later fails, the surrounding rollback restores ``done`` and the
    file stays staged (retryable).
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=IMPORT_JOB_TTL_H)
    result = db.execute(
        update(ExtractionJobModel)
        .where(
            ExtractionJobModel.id == job_id,
            ExtractionJobModel.user_id == user_id,
            ExtractionJobModel.status == "done",
            ExtractionJobModel.updated_at >= cutoff,
        )
        .values(status="saving", updated_at=datetime.now(timezone.utc))
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status_code=404, detail=i18n.tr("import.not_found"))
    return db.query(ExtractionJobModel).filter(ExtractionJobModel.id == job_id).first()


def _attach_staged_file(
    db: Session, entry_id: str, user_id: str, is_anonymous: bool, job: ExtractionJobModel
) -> AttachmentModel:
    """Create the Attachment for a staged import job's file WITHOUT moving it
    on disk (no re-upload — the file was saved at submit time). Storage
    quota is charged HERE (staging was free)."""
    allowed, _current, limit_bytes, _remaining = check_and_record_storage_usage(
        db, user_id, job.file_size, is_anonymous, commit=False
    )
    if not allowed:
        tier = i18n.tr("entries.tier_anonymous" if is_anonymous else "entries.tier_registered")
        raise HTTPException(
            status_code=429,
            detail=i18n.tr(
                "entries.storage_limit_reached", tier=tier, limit_mb=limit_bytes // (1024 * 1024)
            ),
        )
    att = AttachmentModel(
        id=f"att-{uuid.uuid4().hex}",
        entry_id=entry_id,
        name=job.original_filename,
        type="Uploaded Document",
        size=f"{max(job.file_size // 1024, 1)} KB",
        file_path=job.file_path,
    )
    db.add(att)
    db.flush()
    return att


def _consume_staged_job(db: Session, job: ExtractionJobModel) -> None:
    """Delete a claimed job row (in the same commit as the save) together
    with its notification rows — the bell must never offer "Review" for a
    job that no longer exists. Also records the funnel "saved" event (the
    review-completion counter)."""
    from app.services.extract_jobs import record_funnel_event

    db.query(NotificationModel).filter(NotificationModel.job_id == job.id).delete(
        synchronize_session=False
    )
    record_funnel_event(db, "saved", job.user_id, bool(job.is_anonymous))
    db.delete(job)


async def _save_attachment(
    db: Session,
    entry_id: str,
    user_id: str,
    is_anonymous: bool,
    file: Optional[UploadFile],
) -> Optional[AttachmentModel]:
    """Validate size, enforce the storage quota, persist the file on disk and
    create its Attachment row. Returns None when no file was provided. The
    quota UPDATE is deferred (commit=False) so a later failure rolls back the
    upload together with the entry instead of orphaning either."""
    if not file or not file.filename:
        return None
    # Stored-XSS guard: the extension is kept verbatim in the saved name and
    # serve_upload hands files to the browser, so only document/image types
    # that cannot carry same-origin scripts are accepted (same allowlist as
    # the OCR/extract path and the frontend accept attributes).
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ATTACHMENT_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=i18n.tr(
                "ai.unsupported_file_type",
                ext=ext or "(none)",
                allowed=", ".join(sorted(ATTACHMENT_EXTENSIONS)),
            ),
        )
    try:
        content = await read_capped(file, MAX_FILE_SIZE)
    except FileTooLargeError as e:
        raise HTTPException(status_code=413, detail=i18n.tr("entries.file_too_large", kb=e.size // 1024, max_mb=MAX_FILE_SIZE // (1024 * 1024))) from None

    # Enforce storage quota for ALL users (anon: 50MB, registered: 200MB — see config.py).
    allowed, _current_bytes, limit_bytes, _remaining = check_and_record_storage_usage(
        db, user_id, len(content), is_anonymous, commit=False
    )
    if not allowed:
        tier = i18n.tr("entries.tier_anonymous" if is_anonymous else "entries.tier_registered")
        raise HTTPException(
            status_code=429,
            detail=i18n.tr("entries.storage_limit_reached", tier=tier, limit_mb=limit_bytes // (1024*1024))
        )

    ext = os.path.splitext(file.filename)[1]
    saved_name = f"{uuid.uuid4().hex}{ext}"
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    save_path = os.path.join(UPLOAD_DIR, saved_name)
    with open(save_path, "wb") as f:
        f.write(content)

    att = AttachmentModel(
        id=f"att-{uuid.uuid4().hex}",
        entry_id=entry_id,
        name=file.filename,
        type="Uploaded Document",
        size=f"{len(content) // 1024} KB",
        file_path=f"/static/uploads/{saved_name}",
    )
    try:
        db.add(att)
        db.flush()
    except BaseException:
        # The file is on disk but its Attachment row could not be flushed —
        # don't orphan it (ISSUES.md #54).
        with contextlib.suppress(OSError):
            os.remove(save_path)
        raise
    return att


@router.get("/api/entries/by-date", response_model=EntriesByDateResponse)
async def get_entries_by_date(
    request: Request,
    response: Response,
    date: str = Query(...),
    type: str = Query(""),
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, _is_anonymous = user_data
    try:
        target = _normalize_date(date)
    except ValueError:
        raise HTTPException(status_code=400, detail=i18n.tr("entries.invalid_date_format", date=date)) from None
    q = db.query(MedicalEntryModel).filter(
        MedicalEntryModel.patient_id == user_id,
        func.date(MedicalEntryModel.date) == func.date(target),
    )
    if type:
        q = q.filter(MedicalEntryModel.type == type)
    entries = q.order_by(MedicalEntryModel.date).all()

    # Batched fetches (ISSUES.md #59): all readings of the day's entries in
    # one query and one definitions query for the union of referenced ids —
    # instead of one readings + one definitions query per entry.
    entry_ids = [e.id for e in entries]
    all_readings = (
        db.query(BiomarkerReading)
        .filter(BiomarkerReading.entry_id.in_(entry_ids))
        .order_by(BiomarkerReading.id)
        .all()
    ) if entry_ids else []
    readings_by_entry: dict[str, list[BiomarkerReading]] = {}
    union_ids: set[str] = set()
    for r in all_readings:
        readings_by_entry.setdefault(r.entry_id, []).append(r)
        union_ids.add(r.biomarker_id)
    all_defns = (
        db.query(BiomarkerDefinitionModel)
        .filter(
            (BiomarkerDefinitionModel.id.in_(union_ids))
            | (BiomarkerDefinitionModel.loinc_code.in_(union_ids))
        )
        .all()
    ) if union_ids else []

    # Per entry: the definitions its readings reference, so callers can detect
    # biomarker overlap (e.g. when deciding whether two blood tests can merge).
    result_entries = []
    for e in entries:
        readings = readings_by_entry.get(e.id, [])
        reading_ids = {r.biomarker_id for r in readings}
        defn_by_id = {d.id: d for d in all_defns if d.id in reading_ids}
        defn_by_loinc = {
            d.loinc_code: d
            for d in all_defns
            if d.loinc_code and d.loinc_code in reading_ids
        }
        biomarkers = []
        for r in readings:
            defn = defn_by_id.get(r.biomarker_id) or defn_by_loinc.get(r.biomarker_id)
            # Names + synonyms let the client detect conflicts for rows the
            # user typed manually (no definition_id) — the server resolves
            # those by name, so the client must be able to as well.
            biomarkers.append({
                "definition_id": r.biomarker_id,
                "loinc_code": defn.loinc_code if defn else None,
                "names": (defn.names or {}) if defn else {},
                "synonyms": (defn.synonyms or []) if defn else [],
            })
        time_str = e.date.strftime("%H:%M") if (e.date.hour or e.date.minute) else None
        result_entries.append({
            "id": e.id,
            "title": e.title,
            "date": e.date.isoformat(),
            "time": time_str,
            "biomarkers": biomarkers,
        })
    return {"date": date, "count": len(entries), "entries": result_entries}


@router.post("/api/entry", response_model=SaveEntryResponse)
async def save_entry(
    request: Request,
    response: Response,
    type: str = Form(...),
    date: str = Form(""),
    time: str = Form(""),
    clinic: str = Form(""),
    provider: str = Form(""),
    title: str = Form(""),
    notes: str = Form(""),
    # Language of the source document as detected at extraction time (client
    # relays it from the /api/extract result). Empty string = unknown/manual
    # entry; values outside the detector's allowlist are stored as NULL.
    source_language: str = Form(""),
    biomarkers: str = Form("[]"),
    visit_data: str = Form(""),
    instrumental_data: str = Form(""),
    # Batch import: adopt a staged extraction job's result file instead of a
    # fresh upload (the review editor sends the job id after /review-import).
    import_job_id: str = Form(""),
    file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, is_anonymous = user_data
    entry_id = uuid.uuid4().hex
    staged_job = None
    if import_job_id:
        if file and file.filename:
            raise HTTPException(
                status_code=400, detail=i18n.tr("import.job_and_file")
            )
        staged_job = _claim_staged_job(db, import_job_id, user_id)
    try:
        entry_date = _normalize_date(date, time)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=i18n.tr("entries.invalid_datetime_format", error=e)) from e

    if entry_date.date() > datetime.now(timezone.utc).date():
        raise HTTPException(status_code=400, detail=i18n.tr("entries.date_in_future"))

    # Validate every client-supplied JSON payload BEFORE the attachment is
    # written to disk (ISSUES.md #54): a 400 raised after _save_attachment
    # would roll the DB rows back but leave the file on disk with no DB row
    # referencing it (upload_cleanup only runs on delete).
    categories_data = None
    if type == "blood_test" and biomarkers and biomarkers != "[]":
        try:
            categories_data = json.loads(biomarkers)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail=i18n.tr("entries.invalid_biomarkers_json")) from None
    vd = None
    if visit_data and visit_data != "":
        try:
            vd = json.loads(visit_data)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=i18n.tr("entries.invalid_visit_data_json", error=e)) from e
        if not isinstance(vd, dict):
            raise HTTPException(status_code=400, detail=i18n.tr("entries.visit_data_not_object"))
    idv = None
    if instrumental_data and instrumental_data != "":
        try:
            idv = json.loads(instrumental_data)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=i18n.tr("entries.invalid_instrumental_data_json", error=e)) from e
        if not isinstance(idv, dict):
            raise HTTPException(status_code=400, detail=i18n.tr("entries.instrumental_data_not_object"))

    source_language = source_language if source_language in SUPPORTED_LANGUAGES else None
    entry = MedicalEntryModel(
        id=entry_id,
        patient_id=user_id,
        type=type,
        date=entry_date,
        title=title or f"{type.replace('_', ' ').title()} — {date}",
        subtitle=provider,
        category="Labs" if type == "blood_test" else "",
        status="Completed",
        clinic=clinic,
        notes=notes,
        source_language=source_language,
    )
    db.add(entry)
    db.flush()

    att = None
    if staged_job is not None:
        att = _attach_staged_file(db, entry_id, user_id, is_anonymous, staged_job)
    elif file and file.filename:
        att = await _save_attachment(db, entry_id, user_id, is_anonymous, file)

    try:
        # Biomarker readings belong on blood-test entries only. A doctor-visit or
        # instrumental-test save must never persist readings — even if the client
        # sends stale rows (e.g. extraction leftovers after a document-type
        # switch), they would be invisible everywhere (timeline/flowsheet read
        # blood tests only) yet still create definitions and pollute matching.
        if categories_data is not None:
            specs = _parse_biomarker_rows(db, user_id, categories_data)
            _create_reading_rows(db, entry_id, specs, merged=False)
            db.flush()

        if vd is not None:
            db.add(_build_visit_data_model(entry_id, vd, title, provider, entry_date, clinic))
            db.flush()

        if idv is not None:
            db.add(_build_instrumental_data_model(entry_id, idv))
            db.flush()

        if staged_job is not None:
            # Same commit as the save: the job is consumed (row + its bell
            # rows gone; the file stays, now referenced by the Attachment).
            _consume_staged_job(db, staged_job)

        db.commit()
    except BaseException:
        # Safety net (ISSUES.md #54): nothing past this point may leave the
        # saved file on disk without its committed DB row. A staged import
        # job's file is NOT unlinked — the surrounding rollback restores the
        # claim to `done`, so the job (and its file) stays reviewable.
        if att is not None and att.file_path and staged_job is None:
            unlink_upload_file(att.file_path, UPLOAD_DIR)
        raise
    return SaveEntryResponse(success=True, message=i18n.tr("entries.message_entry_saved"), id=entry_id)


@router.post("/api/entry/{entry_id}/merge", response_model=SaveEntryResponse)
async def merge_entry(
    entry_id: str,
    date: str = Form(""),
    title: str = Form(""),
    clinic: str = Form(""),
    provider: str = Form(""),
    time: str = Form(""),
    biomarkers: str = Form("[]"),
    notes: str = Form(""),
    # Batch import: merge a staged job's document into this entry without a
    # re-upload (same staged-file/attachment/conflict semantics as the
    # file-upload merge path).
    import_job_id: str = Form(""),
    file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """Merge a later blood-test upload into an existing entry on the same date:
    new biomarker readings (marked ``merged=True``) are added, the uploaded
    document is attached, and the new doc's notes are appended. The target
    entry's own metadata (date/time/title/clinic/provider) is left untouched.

    The merged upload's OWN metadata (title/clinic/provider/time) is snapshotted
    onto every merged reading as ``merged_source``, so the UI can describe which
    second test the readings came from.

    Merging is refused with 409 when any biomarker definition would be
    duplicated (already present in the target) — a merged entry can't hold two
    readings of the same analyte. The target must be a blood_test owned by the
    current user and (when a date is supplied) dated on that date."""
    _user, user_id, is_anonymous = user_data
    if import_job_id and file and file.filename:
        raise HTTPException(status_code=400, detail=i18n.tr("import.job_and_file"))
    entry = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.id == entry_id,
            MedicalEntryModel.patient_id == user_id,
        )
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail=i18n.tr("entries.entry_not_found", entry_id=entry_id))
    if entry.type != "blood_test":
        raise HTTPException(status_code=400, detail=i18n.tr("entries.merge_only_blood_test"))
    entry_day = entry.date
    if entry_day.tzinfo is None:
        entry_day = entry_day.replace(tzinfo=timezone.utc)
    # Same future-date rule as save_entry (ISSUES.md #55): a merge must not
    # attach readings to a future-dated entry.
    if entry_day.date() > datetime.now(timezone.utc).date():
        raise HTTPException(status_code=400, detail=i18n.tr("entries.date_in_future"))
    if date:
        try:
            target_date = _normalize_date(date)
        except ValueError:
            raise HTTPException(status_code=400, detail=i18n.tr("entries.invalid_date_format", date=date)) from None
        # Compare in Python: sqlite stores naive datetimes, and passing mixed
        # naive/tz-aware values through SQL func.date() is unreliable.
        if entry_day.date() != target_date.date():
            raise HTTPException(status_code=400, detail=i18n.tr("entries.merge_date_mismatch"))

    if biomarkers and biomarkers != "[]":
        try:
            categories_data = json.loads(biomarkers)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail=i18n.tr("entries.invalid_biomarkers_json")) from None
        specs = _parse_biomarker_rows(db, user_id, categories_data)

        # Conflict check: refuse when any resolved definition already has a
        # reading in the target entry (by definition id OR LOINC code).
        conflicts = _detect_merge_conflicts(db, entry, specs)
        if conflicts:
            detail = i18n.tr("entries.merge_conflict") + ", ".join(sorted(set(conflicts)))
            raise HTTPException(status_code=409, detail=detail)

        merged_source = _merged_source_from(title, clinic, provider, time, file)

        _create_reading_rows(db, entry_id, specs, merged=True, merged_source=merged_source)

    if notes:
        entry.notes = (entry.notes + "\n" + notes) if entry.notes else notes

    staged_job = None
    if import_job_id:
        # Claim AFTER the conflict checks: a 409 above leaves nothing
        # claimed; from here a failure rolls the claim back (job stays
        # `done`, file still staged).
        staged_job = _claim_staged_job(db, import_job_id, user_id)
        _attach_staged_file(db, entry_id, user_id, is_anonymous, staged_job)
        _consume_staged_job(db, staged_job)
    elif file and file.filename:
        await _save_attachment(db, entry_id, user_id, is_anonymous, file)

    db.commit()
    return SaveEntryResponse(success=True, message=i18n.tr("entries.message_entry_merged"), id=entry_id)


def _parse_size_to_bytes(size_str: str) -> int:
    """Parse the human-readable `Attachment.size` string (e.g. "312 KB", "2.1 MB")
    into bytes. Returns 0 when the value is missing or unparseable — callers
    treat that as "no quota to refund" rather than failing the delete."""
    if not size_str:
        return 0
    s = size_str.strip().upper().replace(",", ".")
    m = re.match(r"^([\d.]+)\s*(B|KB|MB|GB)?$", s)
    if not m:
        return 0
    value = float(m.group(1))
    unit = m.group(2) or "B"
    if unit == "KB":
        return int(value * 1024)
    if unit == "MB":
        return int(value * 1024 * 1024)
    if unit == "GB":
        return int(value * 1024 * 1024 * 1024)
    return int(value)


def _decrement_storage_quota(db: Session, user_id: str, is_anonymous: bool, freed_bytes: int) -> None:
    """Decrement the user's tracked storage usage by `freed_bytes` (clamped at
    zero) using a single conditional UPDATE so concurrent deletes don't drive
    the counter negative. Missing rows are silently skipped — there's nothing
    to refund against."""
    from app.db.models import UsageLimit
    if freed_bytes <= 0:
        return
    db.execute(
        update(UsageLimit)
        .where(
            UsageLimit.user_id == user_id,
            UsageLimit.is_anonymous == is_anonymous,
            UsageLimit.total_upload_size_bytes >= freed_bytes,
        )
        .values(
            total_upload_size_bytes=UsageLimit.total_upload_size_bytes - freed_bytes,
            last_activity=datetime.now(timezone.utc),
        )
    )


@router.delete("/api/entry/{entry_id}", response_model=DeleteEntryResponse)
async def delete_entry(
    entry_id: str,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """Hard-delete a single entry and its cascade-owned rows (readings, visit
    data, attachments). Attached files on disk are removed only when no other
    entry still references them, so the anon→user migration case (which
    duplicates the attachment row) is safe. Storage quota is decremented by the
    freed bytes of files that are actually unlinked."""
    _user, user_id, is_anonymous = user_data
    entry = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.id == entry_id,
            MedicalEntryModel.patient_id == user_id,
        )
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail=i18n.tr("entries.entry_not_found", entry_id=entry_id))

    # Snapshot attachment file_paths BEFORE the cascade deletes the rows, so we
    # can re-query "are there any remaining references?" after the delete.
    attachment_paths: list[str] = [
        a.file_path for a in entry.attachments if a.file_path
    ]
    attachment_size_bytes = sum(
        _parse_size_to_bytes(a.size or "") for a in entry.attachments
    )

    # Capture visit id BEFORE delete so we can confirm cascade below.
    visit_id = entry.id if entry.visit_data is not None else None

    db.delete(entry)
    db.flush()  # surface cascade + unlink before we touch the filesystem

    freed_bytes = unlink_unreferenced_files(db, attachment_paths, UPLOAD_DIR)

    if freed_bytes > 0:
        # Prefer the on-disk size (truth) over the parsed human string
        # (fuzzy) when we have it. Fall back to the parsed sum only when the
        # file was already missing.
        _decrement_storage_quota(db, user_id, is_anonymous, freed_bytes)
    elif attachment_size_bytes > 0:
        # All attachment files were missing; refund the size we knew about
        # so the counter doesn't overstate storage in use.
        _decrement_storage_quota(db, user_id, is_anonymous, attachment_size_bytes)

    db.commit()

    return {
        "success": True,
        "id": entry_id,
        "deleted_visit_data": visit_id is not None,
        "freed_bytes": freed_bytes,
    }
