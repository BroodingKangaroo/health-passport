"""A2 tests: the import-jobs worker pipeline (app/services/extract_jobs.py).

Covers the full lifecycle against the injected test session with mocked
OCR/LLM/matcher (the pattern of the existing /api/extract tests), progress
rows per stage, failure/cancel refunds, unknown-type success without refund,
exactly-one terminal notification, and the commit-before-close invariant
(definitions written by the match stage survive the worker session close).
"""

import os
import time

import pytest

import app.services.extract_jobs as ej
from app.db.models import (
    BiomarkerDefinition,
    ExtractionJob,
    Notification,
    UsageLimit,
)
from app.schemas.ai import RawBiomarker, RawMedicalRecord, StandardizedMedicalRecord
from app.services.extractor import OCRProcessingError
from tests.test_extract_jobs import TEST_USER_ID, make_job
from tests.test_extract_jobs import jobs_db as jobs_db_fixture  # noqa: F401


@pytest.fixture()
def jobs_db(jobs_db_fixture):  # noqa: F811 -- fixture re-export
    # Re-export the A1 fixture so this module's tests share one setup.
    return jobs_db_fixture


def _usage(db) -> int:
    db.rollback()
    return (
        db.query(UsageLimit)
        .filter(UsageLimit.user_id == TEST_USER_ID)
        .first()
        .ai_extraction_count
    )


def _job_row(db, job_id) -> ExtractionJob:
    db.rollback()
    return db.query(ExtractionJob).filter(ExtractionJob.id == job_id).one()


def wait_for_terminal(db, job_id, timeout=10.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        db.rollback()
        row = db.query(ExtractionJob).filter(ExtractionJob.id == job_id).one()
        last = row
        if row.status in ("done", "failed", "cancelled"):
            return row
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not reach a terminal state (last={last and last.status})")


def staged_file(upload_dir, name="staged-report.pdf", content=b"pdf-bytes"):
    with open(os.path.join(upload_dir, name), "wb") as f:
        f.write(content)
    return f"/static/uploads/{name}"


@pytest.fixture()
def pipeline_mocks(monkeypatch):
    """Mocked OCR/LLM/matcher stages + client. Returns the mocks dict so
    tests can adjust raw records / raise errors / observe the matcher db."""
    mocks = {
        "markdown": "# Lab report\n\nHemoglobin 140 g/L",
        "raw": RawMedicalRecord(
            entry_type="blood_test",
            date="2026-01-15",
            biomarkers=[RawBiomarker(name="Hemoglobin", value="140", unit="g/L")],
        ),
        "result": StandardizedMedicalRecord(entry_type="blood_test"),
        "ocr_error": None,
        "match_error": None,
        # Captures the Session the matcher received (commit-before-close).
        "match_db": None,
        # Extra side effect for the fake matcher (e.g. add a definition).
        "match_side_effect": None,
    }

    def fake_ocr(bytes_data, ext, client):
        if mocks["ocr_error"] is not None:
            raise mocks["ocr_error"]
        return mocks["markdown"]

    def fake_llm_extract(markdown, client):
        return mocks["raw"]

    def fake_match(raw, definitions, db, user_id, client):
        mocks["match_db"] = db
        if mocks["match_side_effect"] is not None:
            mocks["match_side_effect"](db)
        if mocks["match_error"] is not None:
            raise mocks["match_error"]
        return mocks["result"]

    monkeypatch.setattr(ej, "_get_client", lambda: object())
    monkeypatch.setattr(ej.extractor, "ocr_document", fake_ocr)
    monkeypatch.setattr(ej.extractor, "llm_extract", fake_llm_extract)
    monkeypatch.setattr(ej.matcher, "match_and_convert", fake_match)
    return mocks


class TestHappyPath:
    def test_full_lifecycle_done_with_progress_stages(self, jobs_db, pipeline_mocks):
        db, _sm, upload_dir = jobs_db
        job = make_job(db, file_path=staged_file(upload_dir))
        stages_seen = []
        real_set_stage = ej._set_stage

        def spy_set_stage(db_, job_id, stage, progress):
            stages_seen.append(stage)
            real_set_stage(db_, job_id, stage, progress)

        ej._set_stage = spy_set_stage
        try:
            ej.process_job(job.id)
        finally:
            ej._set_stage = real_set_stage

        done = _job_row(db, job.id)
        assert done.status == "done"
        assert done.result["entry_type"] == "blood_test"
        assert done.result["source_language"] is None or isinstance(
            done.result["source_language"], (str, type(None))
        )
        assert done.error_key is None
        assert done.stage == ""
        # All three SSE-equivalent stages were written (same labels).
        assert stages_seen == ["ocr_scanning", "extracting", "matching"]
        # Success: no refund, one done notification.
        assert _usage(db) == 3
        notifications = db.query(Notification).all()
        assert len(notifications) == 1
        assert notifications[0].type == "import_job_done"
        assert notifications[0].payload == {"job_id": job.id, "filename": "lab-report.pdf"}

    def test_unknown_type_is_success_without_refund(self, jobs_db, pipeline_mocks):
        db, _sm, upload_dir = jobs_db
        pipeline_mocks["raw"] = RawMedicalRecord(entry_type="unknown", title="Note")
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.process_job(job.id)
        done = _job_row(db, job.id)
        assert done.status == "done"
        assert done.result["entry_type"] == "unknown"
        assert done.result["biomarkers"] == []
        # The LLM genuinely ran — no refund.
        assert _usage(db) == 3
        assert (
            db.query(Notification).filter(Notification.type == "import_job_done").count() == 1
        )

    def test_definitions_written_by_match_stage_survive_session_close(
        self, jobs_db, pipeline_mocks
    ):
        """Regression test for the documented commit-before-close invariant:
        the worker session must COMMIT (not discard) the definitions the
        match stage anchors — verify_or_create's writes ride the terminal
        commit and must still exist after the worker's session is closed."""
        db, sm, upload_dir = jobs_db

        def add_definition(match_db):
            match_db.add(
                BiomarkerDefinition(
                    id="local-jobworker-testdef",
                    names={"en": "Worker Test Analyte"},
                    category="chemistry",
                    unit="g/L",
                    scope="local",
                    user_id=TEST_USER_ID,
                    reference_source="local",
                )
            )
            match_db.flush()

        pipeline_mocks["match_side_effect"] = add_definition
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.process_job(job.id)
        assert _job_row(db, job.id).status == "done"

        # A brand-new session sees the definition -> the worker committed.
        fresh = sm()
        try:
            found = (
                fresh.query(BiomarkerDefinition)
                .filter(BiomarkerDefinition.id == "local-jobworker-testdef")
                .one()
            )
            assert found.user_id == TEST_USER_ID
        finally:
            fresh.close()

    def test_worker_queue_consumes_enqueued_job(self, jobs_db, pipeline_mocks):
        """The lazy daemon-worker path: enqueue_job starts a worker that
        claims the queued row and completes it."""
        db, _sm, upload_dir = jobs_db
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.enqueue_job(job.id)
        done = wait_for_terminal(db, job.id)
        assert done.status == "done"
        assert done.result["entry_type"] == "blood_test"


class TestFailures:
    def test_ocr_failure_stores_error_key_and_refunds(self, jobs_db, pipeline_mocks):
        db, _sm, upload_dir = jobs_db
        pipeline_mocks["ocr_error"] = OCRProcessingError("boom", kind="quota")
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.process_job(job.id)
        failed = _job_row(db, job.id)
        assert failed.status == "failed"
        assert failed.error_key == "ai.ocr_quota"
        assert _usage(db) == 2  # refunded exactly once
        notifications = db.query(Notification).all()
        assert len(notifications) == 1
        assert notifications[0].type == "import_job_failed"

    def test_unexpected_exception_fails_refunds_and_worker_survives(
        self, jobs_db, pipeline_mocks
    ):
        db, _sm, upload_dir = jobs_db
        pipeline_mocks["match_error"] = RuntimeError("matcher exploded")
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.process_job(job.id)  # must not raise
        failed = _job_row(db, job.id)
        assert failed.status == "failed"
        assert failed.error_key == "import.job_failed_generic"
        assert "matcher exploded" in failed.error_params["error"]
        assert _usage(db) == 2
        assert db.query(Notification).count() == 1

    def test_missing_mistral_key_fails_without_progress(self, jobs_db, monkeypatch):
        db, _sm, upload_dir = jobs_db
        monkeypatch.setattr(ej, "_get_client", lambda: None)
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.process_job(job.id)
        failed = _job_row(db, job.id)
        assert failed.status == "failed"
        assert failed.error_key == "ai.sse_no_mistral_key"
        assert _usage(db) == 2

    def test_missing_staged_file_fails_with_dedicated_key(self, jobs_db, pipeline_mocks):
        db, _sm, _dir = jobs_db
        job = make_job(db, file_path="/static/uploads/never-written.pdf")
        ej.process_job(job.id)
        failed = _job_row(db, job.id)
        assert failed.status == "failed"
        assert failed.error_key == "import.job_failed_file_missing"
        assert _usage(db) == 2


class TestCancel:
    def test_cancel_between_stages_refunds_deletes_file_no_notification(
        self, jobs_db, pipeline_mocks, monkeypatch
    ):
        db, _sm, upload_dir = jobs_db
        staged = staged_file(upload_dir)
        job = make_job(db, file_path=staged)
        import sqlalchemy

        def fake_llm_extract(markdown, client):
            # The user cancels while the (mocked) extraction stage runs —
            # flag the job the way the API-side cancel endpoint would.
            db.execute(
                sqlalchemy.update(ExtractionJob)
                .where(ExtractionJob.id == job.id)
                .values(cancel_requested=True)
            )
            db.commit()
            return RawMedicalRecord(entry_type="blood_test")

        monkeypatch.setattr(ej.extractor, "llm_extract", fake_llm_extract)

        ej.process_job(job.id)
        cancelled = _job_row(db, job.id)
        assert cancelled.status == "cancelled"
        # Refunded + staged file deleted by the worker (it owns the job).
        assert _usage(db) == 2
        assert not os.path.exists(os.path.join(upload_dir, "staged-report.pdf"))
        # Cancelled jobs emit nothing.
        assert db.query(Notification).count() == 0

    def test_already_cancelled_job_is_skipped_without_refund(self, jobs_db, pipeline_mocks):
        """CAS claim loses the race: the API cancel transitioned the queued
        job to cancelled before the worker dequeued it — no double refund."""
        db, _sm, upload_dir = jobs_db
        staged = staged_file(upload_dir)
        job = make_job(db, file_path=staged, status="cancelled")
        ej.process_job(job.id)
        row = _job_row(db, job.id)
        assert row.status == "cancelled"
        assert _usage(db) == 3
        assert db.query(Notification).count() == 0
        assert os.path.exists(os.path.join(upload_dir, "staged-report.pdf"))

    def test_gc_job_vanished_is_noop(self, jobs_db, pipeline_mocks):
        _db, _sm, _dir = jobs_db
        ej.process_job("no-such-job")  # must not raise
