"""Tests for scripts/cleanup_e2e_data.py — the ORM-based e2e cleanup.

The script is loaded from its path (scripts/ is not a package) and driven
against a temporary file-backed DB with a patched uploads dir, so no real
dev DB or file is ever touched."""

import importlib.util
import os
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

BACKEND_DIR = Path(__file__).resolve().parents[1]


def _load_cleanup_module():
    path = BACKEND_DIR / "scripts" / "cleanup_e2e_data.py"
    spec = importlib.util.spec_from_file_location("cleanup_e2e_data", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def cleanup_db(tmp_path, monkeypatch):
    """A file-backed DB with one E2E entry (attachment on disk) and one real
    entry, plus an uploads dir patched into the cleanup service."""
    import app.services.upload_cleanup as upload_cleanup
    from app.db.models import Attachment, MedicalEntry, Patient, UsageLimit
    from app.db.session import Base

    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))

    db_path = tmp_path / "cleanup.db"
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Patient(
        id="user-1", email="cleanup@example.com", hashed_password="x",
        name="Cleanup", dob="1990-01-01", gender="Other", external_id="ext-1",
    ))
    db.add(UsageLimit(
        user_id="user-1", is_anonymous=False, total_upload_size_bytes=5000,
    ))

    e2e_file = upload_dir / "e2e.pdf"
    e2e_file.write_bytes(b"e2e-bytes")
    real_file = upload_dir / "real.pdf"
    real_file.write_bytes(b"real-bytes")

    db.add(MedicalEntry(
        id="e2e-1", patient_id="user-1", type="blood_test",
        date=datetime(2027, 1, 1),
        title="E2E entry", clinic="E2E Clinic",
    ))
    db.add(MedicalEntry(
        id="real-1", patient_id="user-1", type="blood_test",
        date=datetime(2027, 1, 2),
        title="Real entry", clinic="Real Clinic",
    ))
    db.flush()
    db.add(Attachment(
        id="att-e2e", entry_id="e2e-1", name="e2e.pdf", type="Lab Report",
        size="1 KB", file_path="/static/uploads/e2e.pdf",
    ))
    db.add(Attachment(
        id="att-real", entry_id="real-1", name="real.pdf", type="Lab Report",
        size="1 KB", file_path="/static/uploads/real.pdf",
    ))
    db.commit()
    db.close()

    yield db_path, upload_dir
    engine.dispose()


def test_cleanup_deletes_e2e_rows_files_and_refunds(cleanup_db):
    from app.db.models import Attachment, MedicalEntry, UsageLimit

    db_path, upload_dir = cleanup_db
    module = _load_cleanup_module()

    summary = module.cleanup_database(str(db_path))
    assert summary["entries"] == 1
    assert summary["freed_bytes"] == len(b"e2e-bytes")

    engine = create_engine(f"sqlite:///{db_path}")
    db = sessionmaker(bind=engine)()
    try:
        assert db.query(MedicalEntry).filter(MedicalEntry.id == "e2e-1").first() is None
        assert db.query(MedicalEntry).filter(MedicalEntry.id == "real-1").first() is not None
        assert db.query(Attachment).filter(Attachment.entry_id == "e2e-1").count() == 0
        assert db.query(Attachment).filter(Attachment.entry_id == "real-1").count() == 1
        usage = db.query(UsageLimit).filter(UsageLimit.user_id == "user-1").one()
        # 5000 charged - the e2e file's bytes (the real entry is untouched).
        assert usage.total_upload_size_bytes == 5000 - len(b"e2e-bytes")
    finally:
        db.close()
        engine.dispose()

    assert not os.path.exists(upload_dir / "e2e.pdf")
    assert os.path.exists(upload_dir / "real.pdf")


def test_cleanup_noop_on_empty_db(cleanup_db):
    module = _load_cleanup_module()
    db_path, _uploads = cleanup_db
    # Remove the e2e entry first (direct ORM), then the script is a no-op.
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.db.models import MedicalEntry

    engine = create_engine(f"sqlite:///{db_path}")
    db = sessionmaker(bind=engine)()
    db.query(MedicalEntry).filter(MedicalEntry.id == "e2e-1").delete()
    db.commit()
    db.close()
    engine.dispose()

    assert module.cleanup_database(str(db_path)) == {"entries": 0, "freed_bytes": 0}
