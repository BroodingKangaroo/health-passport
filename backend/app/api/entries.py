import json
import os
import re
import uuid
import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional, Tuple, Union

from fastapi import APIRouter, Form, UploadFile, File, Depends, Query, HTTPException, Request, Response
from sqlalchemy import cast, func, or_, String, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.schemas import SaveEntryResponse, DeleteEntryResponse
from app.db.session import get_db
from app.db.models import (
    MedicalEntry as MedicalEntryModel,
    BiomarkerDefinition as BiomarkerDefinitionModel,
    BiomarkerReading,
    Attachment as AttachmentModel,
    VisitData as VisitDataModel,
    Patient,
)
from app.api._format import to_display_datetime, effective_reference
from app.api.auth import get_current_user_or_anon
from app.services.reference import compute_status, merge_reference, parse_value, normalize_qual
from app.services.usage_limits import check_and_record_storage_usage
from config import ANON_STORAGE_BYTES, REGISTERED_STORAGE_BYTES

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB


logger = logging.getLogger(__name__)


_LOINC_RE = re.compile(r"^\d+-\d+(\.\d+)?$")


def _is_loinc(code: Optional[str]) -> bool:
    return bool(code) and bool(_LOINC_RE.match(code))


router = APIRouter()


def _normalize_date(date_str: str, time_str: str = "") -> datetime:
    if not date_str:
        date_str = datetime.now().strftime("%Y-%m-%d")
    if time_str:
        dt = datetime.fromisoformat(f"{date_str}T{time_str}")
    else:
        dt = datetime.fromisoformat(date_str)
    return dt.replace(tzinfo=timezone.utc)


class _ReadingSpec:
    """A parsed, definition-resolved biomarker row, ready to be persisted as a
    BiomarkerReading. Shared by save_entry and the merge endpoint so the two
    never drift apart in semantics."""

    __slots__ = ("defn", "value_col", "value_text", "result_value", "eff_ref", "status", "row")

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
    Mirrors the historical save_entry resolution chain exactly."""
    defn = None
    if row_defn_id:
        defn = db.query(BiomarkerDefinitionModel).filter(BiomarkerDefinitionModel.id == row_defn_id).first()
        # Also resolve by LOINC code (the matcher emits LOINC as definition_id)
        if not defn and _is_loinc(row_defn_id):
            defn = db.query(BiomarkerDefinitionModel).filter(
                BiomarkerDefinitionModel.loinc_code == row_defn_id
            ).first()

    # Fallback: fuzzy match by name using SQL ILIKE
    if not defn:
        name_lower = name.lower()
        # Only match definitions visible to this user: global,
        # system-shared (user_id IS NULL), or this user's own local
        # definitions. This prevents a user's reading from being
        # linked to another user's private local definition.
        ownership = or_(
            BiomarkerDefinitionModel.scope == "global",
            BiomarkerDefinitionModel.user_id.is_(None),
            BiomarkerDefinitionModel.user_id == user_id,
        )
        # Build OR conditions for names and synonyms
        defn = (
            db.query(BiomarkerDefinitionModel)
            .filter(
                or_(
                    func.lower(BiomarkerDefinitionModel.names['en'].as_string()).ilike(name_lower),
                    func.lower(BiomarkerDefinitionModel.names['ru'].as_string()).ilike(name_lower),
                    func.lower(BiomarkerDefinitionModel.names['es'].as_string()).ilike(name_lower),
                    func.lower(BiomarkerDefinitionModel.names['de'].as_string()).ilike(name_lower),
                    func.lower(BiomarkerDefinitionModel.names['fr'].as_string()).ilike(name_lower),
                    func.lower(BiomarkerDefinitionModel.names['he'].as_string()).ilike(name_lower),
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
                    func.lower(cast(BiomarkerDefinitionModel.synonyms, String)).ilike(f'%{name_lower}%'),
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
            db.add(defn)
            try:
                db.flush()
            except IntegrityError:
                db.rollback()
                defn = db.query(BiomarkerDefinitionModel).filter(
                    BiomarkerDefinitionModel.id == defn_id
                ).first()
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
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail=f"File too large ({len(content) // 1024} KB). Maximum allowed size is {MAX_FILE_SIZE // (1024 * 1024)} MB.")

    # Enforce storage quota for ALL users (anon: 50MB, registered: 200MB — see config.py).
    allowed, current_bytes, limit_bytes, remaining = check_and_record_storage_usage(
        db, user_id, len(content), is_anonymous, commit=False
    )
    if not allowed:
        tier = "Anonymous" if is_anonymous else "Registered"
        raise HTTPException(
            status_code=429,
            detail=f"Storage limit reached. {tier} users can upload up to {limit_bytes // (1024*1024)}MB. Please remove old entries or contact support."
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
    db.add(att)
    db.flush()
    return att


@router.get("/api/entries/by-date")
async def get_entries_by_date(
    request: Request,
    response: Response,
    date: str = Query(...),
    type: str = Query(""),
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    user, user_id, is_anonymous = user_data
    try:
        target = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date format: '{date}'. Expected ISO format (YYYY-MM-DD).")
    q = db.query(MedicalEntryModel).filter(
        MedicalEntryModel.patient_id == user_id,
        func.date(MedicalEntryModel.date) == func.date(target),
    )
    if type:
        q = q.filter(MedicalEntryModel.type == type)
    entries = q.order_by(MedicalEntryModel.date).all()

    # Per entry: the definitions its readings reference, so callers can detect
    # biomarker overlap (e.g. when deciding whether two blood tests can merge).
    result_entries = []
    for e in entries:
        readings = (
            db.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == e.id)
            .all()
        )
        reading_ids = {r.biomarker_id for r in readings}
        defns = (
            db.query(BiomarkerDefinitionModel)
            .filter(
                (BiomarkerDefinitionModel.id.in_(reading_ids))
                | (BiomarkerDefinitionModel.loinc_code.in_(reading_ids))
            )
            .all()
        )
        defn_by_id = {d.id: d for d in defns}
        defn_by_loinc = {d.loinc_code: d for d in defns if d.loinc_code}
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
    biomarkers: str = Form("[]"),
    visit_data: str = Form(""),
    file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    user, user_id, is_anonymous = user_data
    entry_id = uuid.uuid4().hex
    try:
        entry_date = _normalize_date(date, time)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date/time format: {e}")

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
    )
    db.add(entry)
    db.flush()

    if file and file.filename:
        await _save_attachment(db, entry_id, user_id, is_anonymous, file)

    if biomarkers and biomarkers != "[]":
        try:
            categories_data = json.loads(biomarkers)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid biomarkers JSON format.")
        specs = _parse_biomarker_rows(db, user_id, categories_data)
        _create_reading_rows(db, entry_id, specs, merged=False)
        db.flush()

    if visit_data and visit_data != "":
        try:
            vd = json.loads(visit_data)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"Invalid visit_data JSON: {e}")
        if not isinstance(vd, dict):
            raise HTTPException(status_code=400, detail="visit_data must be a JSON object")

        diagnosis = vd.get("diagnosis", {})
        chief_complaint = vd.get("chief_complaint", {})
        objective_findings = vd.get("objective_findings", {})

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

        def _get_tx(field, key):
            val = field.get(key) if isinstance(field, dict) else field
            return val if isinstance(val, str) else ""

        db.add(VisitDataModel(
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
        ))
        db.flush()

    db.commit()
    return SaveEntryResponse(success=True, message="Entry saved", id=entry_id)


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
    file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
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
    user, user_id, is_anonymous = user_data
    entry = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.id == entry_id,
            MedicalEntryModel.patient_id == user_id,
        )
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail=f"Entry '{entry_id}' not found")
    if entry.type != "blood_test":
        raise HTTPException(status_code=400, detail="Only blood test entries can be merged into")
    if date:
        try:
            target_date = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid date format: '{date}'. Expected ISO format (YYYY-MM-DD).")
        # Compare in Python: sqlite stores naive datetimes, and passing mixed
        # naive/tz-aware values through SQL func.date() is unreliable.
        entry_day = entry.date
        if entry_day.tzinfo is None:
            entry_day = entry_day.replace(tzinfo=timezone.utc)
        if entry_day.date() != target_date.date():
            raise HTTPException(status_code=400, detail="Entry date does not match the supplied merge date")

    if biomarkers and biomarkers != "[]":
        try:
            categories_data = json.loads(biomarkers)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid biomarkers JSON format.")
        specs = _parse_biomarker_rows(db, user_id, categories_data)

        # Conflict check: refuse when any resolved definition already has a
        # reading in the target entry (by definition id OR LOINC code — a
        # reading's biomarker_id may itself be a LOINC code from legacy
        # ingestion, so both identifier forms are treated as equivalent).
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
        if conflicts:
            detail = "Cannot merge: biomarker(s) already present in this test: " + ", ".join(sorted(set(conflicts)))
            raise HTTPException(status_code=409, detail=detail)

        # Snapshot the merged upload's own metadata so the UI can describe the
        # second test these readings came from. Only non-empty fields are kept.
        # When the user left the title blank, fall back to the uploaded
        # document's filename (sans extension) — far more informative than a
        # generic "Blood Test Panel" placeholder.
        source_title = title.strip()
        if not source_title and file and file.filename:
            source_title = os.path.splitext(os.path.basename(file.filename))[0]
        merged_source = {
            "title": source_title, "clinic": clinic, "provider": provider, "time": time,
        }
        merged_source = {k: v for k, v in merged_source.items() if v} or None

        _create_reading_rows(db, entry_id, specs, merged=True, merged_source=merged_source)

    if notes:
        entry.notes = (entry.notes + "\n" + notes) if entry.notes else notes

    if file and file.filename:
        await _save_attachment(db, entry_id, user_id, is_anonymous, file)

    db.commit()
    return SaveEntryResponse(success=True, message="Entry merged", id=entry_id)


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
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """Hard-delete a single entry and its cascade-owned rows (readings, visit
    data, attachments). Attached files on disk are removed only when no other
    entry still references them, so the anon→user migration case (which
    duplicates the attachment row) is safe. Storage quota is decremented by the
    freed bytes of files that are actually unlinked."""
    user, user_id, is_anonymous = user_data
    entry = (
        db.query(MedicalEntryModel)
        .filter(
            MedicalEntryModel.id == entry_id,
            MedicalEntryModel.patient_id == user_id,
        )
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail=f"Entry '{entry_id}' not found")

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

    freed_bytes = 0
    for file_path in attachment_paths:
        # Path stored as "/static/uploads/{name}" (entries.py:149). Skip
        # anything outside our uploads directory defensively.
        if not file_path.startswith("/static/uploads/"):
            continue
        filename = file_path[len("/static/uploads/"):]
        if not filename or ".." in filename or filename.startswith("/"):
            continue

        still_referenced = (
            db.query(AttachmentModel)
            .filter(AttachmentModel.file_path == file_path)
            .first()
        )
        if still_referenced is not None:
            # Another entry (e.g. the migrated-anon copy) still owns a row that
            # points at the same file. Do not unlink, do not refund.
            continue

        full_path = os.path.join(UPLOAD_DIR, filename)
        try:
            if os.path.isfile(full_path):
                freed_bytes += os.path.getsize(full_path)
                os.remove(full_path)
        except OSError as e:
            # The DB rows are already gone; don't let a stray FS error reverse
            # the cascade. Log and continue.
            logger.warning("Failed to remove uploaded file %s: %s", full_path, e)

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
