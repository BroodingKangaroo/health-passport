"""A7 tests: import-funnel counters (submitted/extracted/saved/failed) and
lifecycle logging hooks. Cancelled jobs write no rows."""

import pytest

import app.services.extract_jobs as ej
from app.db.models import ExtractionJob, ImportFunnelEvent
from app.schemas.ai import RawBiomarker, RawMedicalRecord
from tests.test_extract_jobs import jobs_db as jobs_db_fixture  # noqa: F401
from tests.test_extract_jobs import make_job
from tests.test_extract_jobs_worker import TEST_USER_ID, staged_file
from tests.test_extract_jobs_worker import pipeline_mocks as pipeline_mocks_fixture  # noqa: F401


@pytest.fixture()
def jobs_db(jobs_db_fixture):  # noqa: F811 -- fixture re-export
    # Re-export the A1/A2 fixtures so this module's tests share one setup.
    return jobs_db_fixture


@pytest.fixture()
def pipeline_mocks(pipeline_mocks_fixture):  # noqa: F811 -- fixture re-export
    return pipeline_mocks_fixture


def _events(db, event=None):
    db.rollback()
    q = db.query(ImportFunnelEvent)
    if event is not None:
        q = q.filter(ImportFunnelEvent.event == event)
    return q.all()


class TestFunnelCounters:
    def test_done_writes_extracted_only(self, jobs_db, pipeline_mocks):
        db, _sm, upload_dir = jobs_db
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.process_job(job.id)
        events = _events(db)
        assert [e.event for e in events] == ["extracted"]
        assert events[0].user_id == TEST_USER_ID
        assert events[0].is_anonymous is False

    def test_failed_writes_failed(self, jobs_db, pipeline_mocks):
        db, _sm, upload_dir = jobs_db
        pipeline_mocks["ocr_error"] = ej.extractor.OCRProcessingError("x", kind="quota")
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.process_job(job.id)
        assert [e.event for e in _events(db)] == ["failed"]

    def test_unknown_type_writes_extracted(self, jobs_db, pipeline_mocks):
        db, _sm, upload_dir = jobs_db
        pipeline_mocks["raw"] = RawMedicalRecord(
            entry_type="unknown",
            biomarkers=[RawBiomarker(name="x", value="1", unit="")],
        )
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.process_job(job.id)
        assert [e.event for e in _events(db)] == ["extracted"]

    def test_cancel_writes_no_rows(self, jobs_db, pipeline_mocks, monkeypatch):
        db, _sm, upload_dir = jobs_db
        job = make_job(db, file_path=staged_file(upload_dir))
        import sqlalchemy

        def fake_llm(markdown, client):
            db.execute(
                sqlalchemy.update(ExtractionJob)
                .where(ExtractionJob.id == job.id)
                .values(cancel_requested=True)
            )
            db.commit()
            return RawMedicalRecord(entry_type="blood_test")

        monkeypatch.setattr(ej.extractor, "llm_extract", fake_llm)
        ej.process_job(job.id)
        assert ej_job_status(db, job.id) == "cancelled"
        assert _events(db) == []

    def test_worker_session_untouched_after_finalize(self, jobs_db, pipeline_mocks):
        """Sanity: the funnel row rides the terminal commit — no dangling
        pending rows after process_job returns."""
        db, _sm, upload_dir = jobs_db
        job = make_job(db, file_path=staged_file(upload_dir))
        ej.process_job(job.id)
        db.rollback()  # discard anything uncommitted
        assert len(_events(db)) == 1  # committed, not rolled back


def ej_job_status(db, job_id):
    db.rollback()
    return db.query(ExtractionJob).filter(ExtractionJob.id == job_id).one().status


class TestApiFunnel:
    @pytest.mark.asyncio
    async def test_submit_and_save_writes_counters(self, client, db_session, monkeypatch, tmp_path):
        import io

        from sqlalchemy.orm import sessionmaker

        import app.api.import_jobs as import_api
        from app.services import upload_cleanup

        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        upload_dir = tmp_path / "up7"
        upload_dir.mkdir()
        monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))
        ej.set_sessionmaker(
            sessionmaker(bind=db_session.get_bind(), autocommit=False, autoflush=False)
        )
        try:
            resp = await client.post(
                "/api/import/jobs",
                files={"file": ("r.pdf", io.BytesIO(b"%PDF x"), "application/pdf")},
            )
            assert resp.status_code == 200
            job_id = resp.json()["job_id"]
            db_session.rollback()
            assert [e.event for e in db_session.query(ImportFunnelEvent).all()] == ["submitted"]

            # Save the (manually completed) staged job -> "saved" counter.
            db_session.rollback()
            row = db_session.query(ExtractionJob).filter(ExtractionJob.id == job_id).one()
            row.status = "done"
            db_session.commit()
            resp = await client.post(
                "/api/entry",
                data={"type": "doctor_visit", "date": "2026-01-15", "import_job_id": job_id},
            )
            assert resp.status_code == 200
            db_session.rollback()
            events = [e.event for e in db_session.query(ImportFunnelEvent).all()]
            assert events == ["submitted", "saved"]
        finally:
            ej.set_sessionmaker(None)
