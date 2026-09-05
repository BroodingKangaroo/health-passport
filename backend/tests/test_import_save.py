"""A5 tests: save/merge with import_job_id (staged-file adoption, CAS claim,
storage charge, job consumption) + the anon->register re-key migration."""

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

import app.services.extract_jobs as ej
from app.db.models import (
    Attachment,
    BiomarkerReading,
    ExtractionJob,
    MedicalEntry,
    Notification,
    UsageLimit,
)
from app.services.data_migration import copy_anonymous_data
from tests.test_import_jobs_api import _make_pdf

TEST_ANON_JOB_USER = "anon-job-user"


def _staged_done_job(
    db,
    job_id="job-stage",
    user_id="testuser",
    file_name="staged.pdf",
    content=b"%PDF staged bytes",
    upload_dir=None,
    **overrides,
):
    if upload_dir is not None:
        with open(os.path.join(upload_dir, file_name), "wb") as f:
            f.write(content)
    job = ExtractionJob(
        id=job_id,
        user_id=user_id,
        is_anonymous=overrides.pop("is_anonymous", False),
        status=overrides.pop("status", "done"),
        original_filename=overrides.pop("original_filename", "Staged Report.pdf"),
        file_path=overrides.pop("file_path", f"/static/uploads/{file_name}"),
        file_size=overrides.pop("file_size", len(content)),
        result={"entry_type": "blood_test"},
        **overrides,
    )
    db.add(job)
    db.commit()
    return job


def _staged_path(api_env):
    return api_env["upload_dir"]


BIOMARKERS = (
    '[{"name":"General","rows":[{"name":"Hemoglobin","value":"140","unit":"g/L"}]}]'
)


class TestSaveWithJobId:
    @pytest.fixture(autouse=True)
    def _no_mistral_needed(self, monkeypatch):
        # save/merge never call the extraction pipeline.
        yield

    @pytest.mark.asyncio
    async def test_save_creates_entry_attachment_charges_storage_deletes_job(
        self, client, db_session, monkeypatch, tmp_path
    ):
        from app.services import upload_cleanup

        upload_dir = tmp_path / "up"
        upload_dir.mkdir()
        monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))
        job = _staged_done_job(db_session, upload_dir=str(upload_dir))
        db_session.add(Notification(
            id=uuid.uuid4().hex, user_id="testuser", job_id=job.id,
            type="import_job_done", payload={"job_id": job.id, "filename": "x"},
        ))
        db_session.commit()

        resp = await client.post(
            "/api/entry",
            data={"type": "blood_test", "date": "2026-01-15", "title": "Panel",
                  "biomarkers": BIOMARKERS, "import_job_id": job.id},
        )
        assert resp.status_code == 200, resp.text
        entry_id = resp.json()["id"]
        db_session.rollback()
        db_session.query(MedicalEntry).filter(MedicalEntry.id == entry_id).one()
        att = db_session.query(Attachment).filter(Attachment.entry_id == entry_id).one()
        assert att.file_path == job.file_path  # adopted, not re-uploaded
        assert att.name == "Staged Report.pdf"
        # The staged file is still on disk (now owned by the attachment).
        assert os.path.isfile(os.path.join(str(upload_dir), os.path.basename(att.file_path)))
        # Storage quota charged here (staging was free).
        usage = db_session.query(UsageLimit).filter(UsageLimit.user_id == "testuser").one()
        assert usage.total_upload_size_bytes == job.file_size
        # The job row is kept as a SAVED history record: result cleared, the
        # entry linked, bell rows consumed in the same commit.
        saved_row = db_session.query(ExtractionJob).filter(ExtractionJob.id == job.id).one()
        assert saved_row.status == "saved"
        assert saved_row.saved_entry_id == entry_id
        assert saved_row.result is None
        assert db_session.query(Notification).filter(Notification.job_id == job.id).count() == 0
        # The staged file is NOT unlinked — the attachment references it.
        assert os.path.isfile(os.path.join(str(upload_dir), os.path.basename(att.file_path)))

    @pytest.mark.asyncio
    async def test_save_rejects_foreign_queued_expired_jobs(
        self, client, db_session, monkeypatch, tmp_path
    ):
        from app.services import upload_cleanup

        upload_dir = tmp_path / "up2"
        upload_dir.mkdir()
        monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))
        _staged_done_job(db_session, job_id="job-f", user_id="someone-else")
        _staged_done_job(db_session, job_id="job-q", status="queued")
        expired = _staged_done_job(db_session, job_id="job-e")
        expired.updated_at = datetime.now(timezone.utc) - timedelta(hours=200)
        db_session.commit()
        for bad in ("job-f", "job-q", "job-e", "no-such-job"):
            resp = await client.post(
                "/api/entry",
                data={"type": "doctor_visit", "date": "2026-01-15", "import_job_id": bad},
            )
            assert resp.status_code == 404, (bad, resp.status_code)
        db_session.rollback()
        # Nothing consumed, nothing charged.
        assert db_session.query(ExtractionJob).filter(
            ExtractionJob.id.in_(["job-f", "job-q", "job-e"])
        ).count() == 3
        assert db_session.query(UsageLimit).filter(UsageLimit.user_id == "testuser").first() is None

    @pytest.mark.asyncio
    async def test_save_failure_rolls_back_claim_job_stays_done(
        self, client, db_session, monkeypatch, tmp_path
    ):
        from app.api import entries as entries_api
        from app.services import upload_cleanup

        upload_dir = tmp_path / "up3"
        upload_dir.mkdir()
        monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))
        job = _staged_done_job(db_session, upload_dir=str(upload_dir))

        def boom(*a, **k):
            raise RuntimeError("reading insert failed")

        monkeypatch.setattr(entries_api, "_create_reading_rows", boom)
        with pytest.raises(RuntimeError, match="reading insert failed"):
            await client.post(
                "/api/entry",
                data={"type": "blood_test", "date": "2026-01-15",
                      "biomarkers": BIOMARKERS, "import_job_id": job.id},
            )
        db_session.rollback()
        # Claim rolled back: the job stays done and reviewable, its file
        # still staged, storage NOT charged.
        row = db_session.query(ExtractionJob).filter(ExtractionJob.id == job.id).one()
        assert row.status == "done"
        assert os.path.isfile(os.path.join(str(upload_dir), os.path.basename(job.file_path)))
        usage = db_session.query(UsageLimit).filter(UsageLimit.user_id == "testuser").first()
        assert usage is None or usage.total_upload_size_bytes == 0

    @pytest.mark.asyncio
    async def test_save_job_and_file_conflict(self, client, db_session):
        job = _staged_done_job(db_session, job_id="job-both")
        resp = await client.post(
            "/api/entry",
            data={"type": "doctor_visit", "date": "2026-01-15", "import_job_id": job.id},
            files=_make_pdf(),
        )
        assert resp.status_code == 400

    def test_gc_never_sweeps_saving_or_saved_rows_and_recovery_restores_claims(
        self, monkeypatch, tmp_path
    ):
        """CAS claim vs GC: a 'saving' row is invisible to the sweep (the
        staged file cannot be unlinked mid-save) and boot recovery restores
        it to done (the save rolled back with the process). A 'saved'
        history row never expires either."""
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        engine = create_engine(f"sqlite:///{tmp_path}/a5.db")
        from app.db.session import Base

        Base.metadata.create_all(bind=engine)
        sm = sessionmaker(bind=engine, autocommit=False, autoflush=False)
        ej.set_sessionmaker(sm)
        try:
            db = sm()
            db.add(UsageLimit(user_id="u", is_anonymous=False, ai_extraction_count=1))
            claimed = ExtractionJob(
                id="job-claiming", user_id="u", status="saving",
                original_filename="c.pdf", file_path="/static/uploads/c.pdf",
                file_size=5, updated_at=datetime.now(timezone.utc) - timedelta(hours=200),
            )
            history = ExtractionJob(
                id="job-history", user_id="u", status="saved",
                original_filename="h.pdf", file_path="/static/uploads/h.pdf",
                file_size=5, updated_at=datetime.now(timezone.utc) - timedelta(hours=200),
            )
            expired = ExtractionJob(
                id="job-expired", user_id="u", status="done",
                original_filename="e.pdf", file_path="/static/uploads/e.pdf",
                file_size=5, updated_at=datetime.now(timezone.utc) - timedelta(hours=200),
            )
            db.add_all([claimed, history, expired])
            db.commit()
            assert ej.sweep_expired_jobs() == 1  # only the plain expired row
            db.rollback()
            assert db.query(ExtractionJob).filter(ExtractionJob.id == "job-claiming").count() == 1
            assert db.query(ExtractionJob).filter(ExtractionJob.id == "job-history").count() == 1
            summary = ej.recover_orphan_jobs()
            assert summary["restored"] == 1
            db.rollback()
            restored = db.query(ExtractionJob).filter(ExtractionJob.id == "job-claiming").one()
            assert restored.status == "done"
            db.close()
        finally:
            ej.set_sessionmaker(None)


class TestMergeWithJobId:
    @pytest.mark.asyncio
    async def test_merge_happy_path(self, client, db_session, monkeypatch, tmp_path):
        from app.services import upload_cleanup

        upload_dir = tmp_path / "up4"
        upload_dir.mkdir()
        monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))
        entry = MedicalEntry(
            id="entry-merge-target", patient_id="testuser", type="blood_test",
            date=datetime(2026, 1, 15, 10, 0), title="Morning panel",
        )
        db_session.add(entry)
        job = _staged_done_job(db_session, job_id="job-m", upload_dir=str(upload_dir))
        db_session.commit()

        resp = await client.post(
            "/api/entry/entry-merge-target/merge",
            data={"date": "2026-01-15", "title": "Evening panel",
                  "biomarkers": BIOMARKERS, "import_job_id": job.id},
        )
        assert resp.status_code == 200, resp.text
        db_session.rollback()
        readings = (
            db_session.query(BiomarkerReading)
            .filter(BiomarkerReading.entry_id == "entry-merge-target")
            .all()
        )
        assert len(readings) == 1
        assert readings[0].merged is True
        att = (
            db_session.query(Attachment)
            .filter(Attachment.entry_id == "entry-merge-target")
            .one()
        )
        assert att.file_path == job.file_path
        usage = db_session.query(UsageLimit).filter(UsageLimit.user_id == "testuser").one()
        assert usage.total_upload_size_bytes == job.file_size
        saved_row = db_session.query(ExtractionJob).filter(ExtractionJob.id == job.id).one()
        assert saved_row.status == "saved"
        assert saved_row.saved_entry_id == "entry-merge-target"

    @pytest.mark.asyncio
    async def test_merge_conflict_keeps_job_done(self, client, db_session, monkeypatch, tmp_path):
        from app.services import upload_cleanup

        upload_dir = tmp_path / "up5"
        upload_dir.mkdir()
        monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))
        entry = MedicalEntry(
            id="entry-conflict", patient_id="testuser", type="blood_test",
            date=datetime(2026, 1, 15, 10, 0), title="First panel",
        )
        db_session.add(entry)
        db_session.flush()
        job = _staged_done_job(db_session, job_id="job-c", upload_dir=str(upload_dir))
        db_session.commit()

        first = await client.post(
            "/api/entry/entry-conflict/merge",
            data={"date": "2026-01-15", "biomarkers": BIOMARKERS, "import_job_id": job.id},
        )
        assert first.status_code == 200
        db_session.rollback()
        # Second merge of the same analyte conflicts -> 409.
        job2 = _staged_done_job(db_session, job_id="job-c2", upload_dir=str(upload_dir))
        resp = await client.post(
            "/api/entry/entry-conflict/merge",
            data={"date": "2026-01-15", "biomarkers": BIOMARKERS, "import_job_id": job2.id},
        )
        assert resp.status_code == 409
        db_session.rollback()
        row = db_session.query(ExtractionJob).filter(ExtractionJob.id == job2.id).one()
        assert row.status == "done"  # claim rolled back with the conflict
        assert db_session.query(Attachment).filter(Attachment.entry_id == "entry-conflict").count() == 1


class TestAnonMigration:
    def test_migration_rekeys_jobs_and_notifications(self, tmp_path):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        from app.db.session import Base

        engine = create_engine(f"sqlite:///{tmp_path}/mig.db")
        Base.metadata.create_all(bind=engine)
        sm = sessionmaker(bind=engine, autocommit=False, autoflush=False)
        ej.set_sessionmaker(sm)
        try:
            db = sm()
            anon_id, new_user = "anon-mig", "registered-mig"
            db.add(ExtractionJob(
                id="job-anon", user_id=anon_id, status="done",
                original_filename="a.pdf", file_path="/static/uploads/a.pdf", file_size=5,
            ))
            db.add(Notification(
                id=uuid.uuid4().hex, user_id=anon_id, job_id="job-anon",
                type="import_job_done", payload={"job_id": "job-anon"},
            ))
            db.commit()
            summary = copy_anonymous_data(db, anon_id, new_user)
            assert summary["import_jobs_migrated"] == 1
            assert summary["notifications_migrated"] == 1
            db.rollback()
            job = db.query(ExtractionJob).filter(ExtractionJob.id == "job-anon").one()
            assert job.user_id == new_user
            note = db.query(Notification).filter(Notification.job_id == "job-anon").one()
            assert note.user_id == new_user
            db.close()
        finally:
            ej.set_sessionmaker(None)
