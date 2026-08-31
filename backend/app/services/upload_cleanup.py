"""Shared uploaded-file cleanup for entry and account deletion.

A file may be referenced by multiple Attachment rows (the anon→user
migration duplicates the row, `app/api/auth.py`), so a path may only be
unlinked when NO attachment row remains — the same guard as
`DELETE /api/entry`, extracted so account deletion cannot diverge from it.
"""

import logging
import os
from typing import Optional

from sqlalchemy.orm import Session

from app.db.models import Attachment as AttachmentModel

logger = logging.getLogger(__name__)

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(_BASE_DIR, "static", "uploads")
_PATH_PREFIX = "/static/uploads/"


def unlink_upload_file(file_path: str, upload_dir: Optional[str] = None) -> int:
    """Unlink a single uploaded file given its stored web path
    (``/static/uploads/<name>``). Traversal-guarded and best-effort — an
    OSError never propagates. Returns the freed bytes (0 when nothing was
    removed), so callers can use it as a cleanup safety net (ISSUES.md #54)."""
    if not file_path or not file_path.startswith(_PATH_PREFIX):
        return 0
    filename = file_path[len(_PATH_PREFIX):]
    if not filename or ".." in filename or filename.startswith("/"):
        return 0
    full_path = os.path.join(upload_dir or UPLOAD_DIR, filename)
    try:
        if os.path.isfile(full_path):
            freed = os.path.getsize(full_path)
            os.remove(full_path)
            return freed
    except OSError as e:
        logger.warning("Failed to remove uploaded file %s: %s", full_path, e)
    return 0


def unlink_unreferenced_files(db: Session, file_paths: list, upload_dir: Optional[str] = None) -> int:
    """Unlink on-disk uploads that no Attachment row still references.

    Must be called AFTER the owning rows are deleted (and flushed), so the
    remaining-reference query sees only other principals' rows. Skips
    anything outside the uploads directory defensively. Returns the freed
    bytes; an OSError never propagates (the DB rows are already gone).

    ``upload_dir`` defaults to this module's ``UPLOAD_DIR`` read at call
    time (so tests can monkeypatch it); callers with their own constant
    (e.g. ``app.api.entries``) pass it explicitly.
    """
    upload_dir = upload_dir or UPLOAD_DIR
    freed = 0
    for file_path in file_paths:
        if not file_path or not file_path.startswith(_PATH_PREFIX):
            continue
        filename = file_path[len(_PATH_PREFIX):]
        if not filename or ".." in filename or filename.startswith("/"):
            continue
        still_referenced = (
            db.query(AttachmentModel)
            .filter(AttachmentModel.file_path == file_path)
            .first()
        )
        if still_referenced is not None:
            continue
        freed += unlink_upload_file(file_path, upload_dir)
    return freed
