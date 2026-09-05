"""A1 tests: ExtractionJob/Notification models, startup recovery, expiry GC,
single-process guard, SQLite WAL/busy_timeout infra."""

import os
import queue as queue_mod
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

import app.services.extract_jobs as ej
from app.db.models import ExtractionJob, Notification, UsageLimit
from app.db.session import Base, configure_sqlite_engine
from app.services import upload_cleanup

TEST_USER_ID = "testuser-jobs"
JOB_FILE_NAME = "job-staged-abc123.pdf"


@pytest.fixture()
def jobs_db(monkeypatch, tmp_path):
    """Fresh file-backed engine wired into the extract_jobs sessionmaker seam
    (file-backed so worker threads see the same DB; in-memory sqlite is
    per-connection), with WAL+busy_timeout and the staged-file directory
    pointed at a temp dir."""
    db_dir = tmp_path / "db"
    db_dir.mkdir()
    engine = create_engine(f"sqlite:///{db_dir}/jobs.db")
    configure_sqlite_engine(engine)
    Base.metadata.create_all(bind=engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    ej.set_sessionmaker(TestingSessionLocal)

    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))

    db = TestingSessionLocal()
    db.add(UsageLimit(user_id=TEST_USER_ID, is_anonymous=False, ai_extraction_count=3))
    db.commit()
    yield db, TestingSessionLocal, str(upload_dir)
    db.close()
    ej.set_sessionmaker(None)
    # Drain anything a test enqueued so later tests start clean.
    while True:
        try:
            ej.job_queue.get_nowait()
        except queue_mod.Empty:
            break


def make_job(db, **overrides) -> ExtractionJob:
    job = ExtractionJob(
        id=overrides.pop("id", "job-" + os.urandom(8).hex()),
        user_id=overrides.pop("user_id", TEST_USER_ID),
        is_anonymous=overrides.pop("is_anonymous", False),
        status=overrides.pop("status", "queued"),
        original_filename=overrides.pop("original_filename", "lab-report.pdf"),
        file_path=overrides.pop("file_path", f"/static/uploads/{JOB_FILE_NAME}"),
        file_size=overrides.pop("file_size", 1234),
        **overrides,
    )
    db.add(job)
    db.commit()
    return job


def get_usage(db) -> UsageLimit:
    return db.query(UsageLimit).filter(UsageLimit.user_id == TEST_USER_ID).first()


class TestModelDefaults:
    def test_job_defaults(self, jobs_db):
        db, _sm, _dir = jobs_db
        job = make_job(db)
        assert job.status == "queued"
        assert job.stage == ""
        assert job.is_anonymous is False
        assert job.result is None
        assert job.error_key is None
        assert job.created_at is not None
        assert job.updated_at is not None

    def test_notification_defaults(self, jobs_db):
        db, _sm, _dir = jobs_db
        job = make_job(db)
        ej.emit_job_notification(db, job, "import_job_done")
        db.commit()
        row = db.query(Notification).one()
        assert row.user_id == TEST_USER_ID
        assert row.job_id == job.id
        assert row.type == "import_job_done"
        assert row.payload == {"job_id": job.id, "filename": "lab-report.pdf"}
        assert row.read_at is None
        assert row.created_at is not None


class TestStartupRecovery:
    def test_orphan_processing_fails_refunds_notifies(self, jobs_db):
        db, _sm, _dir = jobs_db
        job = make_job(db, status="processing", stage="matching")
        summary = ej.recover_orphan_jobs()
        assert summary == {"failed": 1, "requeued": 0, "restored": 0}
        db.expire_all()
        recovered = db.query(ExtractionJob).filter(ExtractionJob.id == job.id).one()
        assert recovered.status == "failed"
        assert recovered.error_key == "import.job_failed_interrupted"
        # Refund exactly once: 3 charged -> 2.
        assert get_usage(db).ai_extraction_count == 2
        notifications = db.query(Notification).all()
        assert len(notifications) == 1
        assert notifications[0].type == "import_job_failed"
        assert notifications[0].job_id == job.id
        assert notifications[0].user_id == TEST_USER_ID

    def test_orphan_queued_reenqueued(self, jobs_db, monkeypatch):
        # No worker threads in this unit test — the queue is asserted
        # directly; the full re-enqueue->resume path is covered in A2 tests.
        monkeypatch.setattr(ej, "_ensure_workers", lambda: None)
        db, _sm, _dir = jobs_db
        job = make_job(db, status="queued")
        summary = ej.recover_orphan_jobs()
        assert summary == {"failed": 0, "requeued": 1, "restored": 0}
        db.expire_all()
        recovered = db.query(ExtractionJob).filter(ExtractionJob.id == job.id).one()
        assert recovered.status == "queued"
        # Landed in the fresh in-memory queue; nothing refunded, no bell row.
        assert ej.job_queue.get_nowait() == job.id
        assert get_usage(db).ai_extraction_count == 3
        assert db.query(Notification).count() == 0

    def test_recovery_is_idempotent(self, jobs_db):
        db, _sm, _dir = jobs_db
        make_job(db, status="processing")
        ej.recover_orphan_jobs()
        # Second run (e.g. a retry of boot): nothing left to recover, no
        # double refund, no duplicate notification.
        summary = ej.recover_orphan_jobs()
        assert summary == {"failed": 0, "requeued": 0, "restored": 0}
        assert get_usage(db).ai_extraction_count == 2
        assert db.query(Notification).count() == 1


class TestGcSweep:
    def _expire(self, db, job):
        job.updated_at = datetime.now(timezone.utc) - timedelta(hours=200)
        db.commit()

    def test_gc_removes_expired_job_file_notifications(self, jobs_db):
        db, _sm, upload_dir = jobs_db
        expired = make_job(db, status="done")
        self._expire(db, expired)
        live = make_job(db, status="processing", file_path="/static/uploads/live.bin")
        # Staged file on disk + notification rows for both jobs.
        staged = os.path.join(upload_dir, JOB_FILE_NAME)
        with open(staged, "wb") as f:
            f.write(b"pdf-bytes")
        ej.emit_job_notification(db, expired, "import_job_done")
        ej.emit_job_notification(db, live, "import_job_failed")
        db.commit()
        expired_id, live_id = expired.id, live.id

        removed = ej.sweep_expired_jobs()
        assert removed == 1
        db.expire_all()
        assert db.query(ExtractionJob).filter(ExtractionJob.id == expired_id).count() == 0
        assert db.query(ExtractionJob).filter(ExtractionJob.id == live_id).count() == 1
        # The expired job's notification rows are gone (the bell must never
        # offer "Review" on a 404'd job); the live job's remain.
        assert db.query(Notification).filter(Notification.job_id == expired_id).count() == 0
        assert db.query(Notification).filter(Notification.job_id == live_id).count() == 1
        assert not os.path.exists(staged)
        # done jobs consumed their extraction — no refund.
        assert get_usage(db).ai_extraction_count == 3

    def test_gc_refunds_nonterminal_expired_jobs(self, jobs_db):
        db, _sm, _dir = jobs_db
        expired_processing = make_job(db, status="processing")
        expired_queued = make_job(db, status="queued")
        for j in (expired_processing, expired_queued):
            self._expire(db, j)
        removed = ej.sweep_expired_jobs()
        assert removed == 2
        # Each non-terminal job refunds exactly once: 3 - 2 = 1.
        assert get_usage(db).ai_extraction_count == 1

    def test_gc_leaves_fresh_jobs_alone(self, jobs_db):
        db, _sm, _dir = jobs_db
        make_job(db, status="done")
        assert ej.sweep_expired_jobs() == 0
        assert db.query(ExtractionJob).count() == 1


class TestSingleProcessGuard:
    def test_guard_trips_on_live_foreign_pid(self, monkeypatch, tmp_path):
        pid_file = tmp_path / "db" / ".job-worker.pid"
        pid_file.parent.mkdir()
        live_foreign_pid = os.getppid()  # alive, not this process
        pid_file.write_text(str(live_foreign_pid))
        monkeypatch.setattr(
            ej, "DATABASE_URL", f"sqlite:///{tmp_path}/db/health_passport.db"
        )
        with pytest.raises(RuntimeError, match="pid"):
            ej.assert_single_process()

    def test_guard_takes_over_stale_pid(self, monkeypatch, tmp_path):
        pid_file = tmp_path / "db" / ".job-worker.pid"
        pid_file.parent.mkdir()
        pid_file.write_text("999999999")  # assumed dead
        monkeypatch.setattr(
            ej, "DATABASE_URL", f"sqlite:///{tmp_path}/db/health_passport.db"
        )
        ej.assert_single_process()
        assert pid_file.read_text() == str(os.getpid())

    def test_guard_skips_memory_db(self, monkeypatch):
        monkeypatch.setattr(ej, "DATABASE_URL", "sqlite:///:memory:")
        ej.assert_single_process()  # no pid file written, no raise
        monkeypatch.setattr(ej, "DATABASE_URL", "sqlite://")
        ej.assert_single_process()


class TestSqliteInfra:
    def test_wal_and_busy_timeout_on_file_db(self, tmp_path):
        engine = create_engine(f"sqlite:///{tmp_path}/x.db")
        configure_sqlite_engine(engine)
        with engine.connect() as conn:
            assert conn.execute(text("PRAGMA journal_mode")).scalar() == "wal"
            assert conn.execute(text("PRAGMA busy_timeout")).scalar() == 10000

    def test_no_wal_on_memory_db(self):
        engine = create_engine("sqlite:///:memory:")
        configure_sqlite_engine(engine)
        with engine.connect() as conn:
            # In-memory DBs cannot switch journal mode.
            assert conn.execute(text("PRAGMA journal_mode")).scalar() == "memory"
            assert conn.execute(text("PRAGMA busy_timeout")).scalar() == 10000
