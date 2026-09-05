"""A4 tests: import-jobs API (submit / list / detail / cancel / retry /
dismiss) with quota, validation, pending-cap, tenant-scoping and CAS rules."""

import io
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.api.import_jobs as import_api
import app.services.extract_jobs as ej
from app.api.import_jobs import router as import_jobs_router
from app.api.notifications import router as notifications_router
from app.db.models import ExtractionJob, Notification, UsageLimit
from app.db.session import Base, get_db
from app.schemas.ai import StandardizedMedicalRecord
from app.services import upload_cleanup
from tests.seed_data import TEST_USER_ID, seed_test_db

OTHER_USER_ID = "other-user-imports"
PDF_BYTES = b"%PDF-1.4 fake report"


def _make_pdf(name="report.pdf", content=PDF_BYTES):
    return {"file": (name, io.BytesIO(content), "application/pdf")}


def _usage(db, user_id=TEST_USER_ID):
    db.rollback()
    row = db.query(UsageLimit).filter(UsageLimit.user_id == user_id).first()
    return row.ai_extraction_count if row else 0


def _set_usage(db, count, user_id=TEST_USER_ID):
    row = db.query(UsageLimit).filter(UsageLimit.user_id == user_id).first()
    if row is None:
        row = UsageLimit(user_id=user_id, is_anonymous=False, ai_extraction_count=0)
        db.add(row)
    row.ai_extraction_count = count
    db.commit()
    return row


@pytest_asyncio.fixture
async def api(client, db_session, monkeypatch, tmp_path):
    """The conftest `client` app + worker seams pointed at the test engine
    and a temp staged-file dir. The real worker is NOT started: tests drive
    process_job directly with the A2-style pipeline mocks (the thread path
    itself is covered by the A2 suite)."""
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))
    sm = sessionmaker(
        autocommit=False, autoflush=False, bind=db_session.get_bind()
    )
    ej.set_sessionmaker(sm)
    monkeypatch.setattr(ej, "_ensure_workers", lambda: None)
    yield {"upload_dir": str(upload_dir), "db": db_session, "client": client}
    ej.set_sessionmaker(None)
    while True:
        try:
            ej.job_queue.get_nowait()
        except Exception:
            break


@pytest_asyncio.fixture
async def anon_api(db_session, monkeypatch, tmp_path):
    """Anonymous principal against the same routers (bell + tracker work for
    anon's <=5-doc imports)."""
    from app.api.auth import get_current_user_or_anon

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    sm = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db = sm()
    seed_test_db(db)

    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    monkeypatch.setattr(upload_cleanup, "UPLOAD_DIR", str(upload_dir))
    ej.set_sessionmaker(sm)
    monkeypatch.setattr(ej, "_ensure_workers", lambda: None)

    app = FastAPI()
    app.include_router(import_jobs_router)
    app.include_router(notifications_router)

    async def override_get_db():
        yield db

    async def override_anon(request=None, response=None):
        return (None, "anon-import-user", True)

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user_or_anon] = override_anon
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield {"upload_dir": str(upload_dir), "db": db, "client": ac}
    db.close()
    ej.set_sessionmaker(None)
    while True:
        try:
            ej.job_queue.get_nowait()
        except Exception:
            break


class TestSubmit:
    @pytest.mark.asyncio
    async def test_submit_charges_and_enqueues(self, api, monkeypatch):
        env, client = api["db"], api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        resp = await client.post("/api/import/jobs", files=_make_pdf())
        assert resp.status_code == 200
        job_id = resp.json()["job_id"]
        assert job_id
        assert _usage(env) == 1
        row = env.query(ExtractionJob).filter(ExtractionJob.id == job_id).one()
        assert row.status == "queued"
        assert row.file_size == len(PDF_BYTES)
        assert row.file_path.startswith("/static/uploads/")
        assert os.path.isfile(os.path.join(api["upload_dir"], os.path.basename(row.file_path)))

    @pytest.mark.asyncio
    async def test_submit_validation_errors(self, api, monkeypatch):
        env, client = api["db"], api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        # Bad extension.
        resp = await client.post("/api/import/jobs", files=_make_pdf("report.txt"))
        assert resp.status_code == 400
        assert "unsupported" in resp.json()["detail"].lower() or "txt" in resp.json()["detail"]
        # Empty file.
        resp = await client.post("/api/import/jobs", files=_make_pdf(content=b""))
        assert resp.status_code == 400
        # Oversized.
        big = b"x" * (21 * 1024 * 1024)
        resp = await client.post(
            "/api/import/jobs", files=_make_pdf("big.pdf", big)
        )
        assert resp.status_code == 413
        # No filename: 400 from our check, or 422 if multipart rejects it —
        # either way a client error, and nothing is charged.
        resp = await client.post(
            "/api/import/jobs", files={"file": ("", io.BytesIO(PDF_BYTES), "application/pdf")}
        )
        assert resp.status_code in (400, 422)
        # Nothing charged by failed submissions.
        assert _usage(env) == 0
        assert env.query(ExtractionJob).count() == 0

    @pytest.mark.asyncio
    async def test_submit_without_mistral_key_not_charged(self, api, monkeypatch):
        env, client = api["db"], api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: None)
        resp = await client.post("/api/import/jobs", files=_make_pdf())
        assert resp.status_code == 503
        assert _usage(env) == 0

    @pytest.mark.asyncio
    async def test_submit_quota_429(self, api, monkeypatch):
        env, client = api["db"], api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        _set_usage(env, 50)  # registered limit
        resp = await client.post("/api/import/jobs", files=_make_pdf())
        assert resp.status_code == 429
        assert "50" in resp.json()["detail"]
        assert _usage(env) == 50  # unchanged

    @pytest.mark.asyncio
    async def test_pending_cap_jobs(self, api, monkeypatch):
        env, client = api["db"], api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        monkeypatch.setattr(import_api, "IMPORT_PENDING_MAX_JOBS", 2)
        for _ in range(2):
            assert (await client.post("/api/import/jobs", files=_make_pdf())).status_code == 200
        resp = await client.post("/api/import/jobs", files=_make_pdf())
        assert resp.status_code == 429
        assert "pending imports" in resp.json()["detail"]
        assert _usage(env) == 2  # the rejected submit did not charge

    @pytest.mark.asyncio
    async def test_pending_cap_staged_bytes(self, api, monkeypatch):
        client = api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        monkeypatch.setattr(import_api, "IMPORT_PENDING_MAX_STAGED_MB", 1)
        big = b"x" * (700 * 1024)
        assert (await client.post("/api/import/jobs", files=_make_pdf("a.pdf", big))).status_code == 200
        resp = await client.post("/api/import/jobs", files=_make_pdf("b.pdf", big))
        assert resp.status_code == 429
        assert "storage" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_submit_runs_gc(self, api, monkeypatch):
        """Lazy global GC on the submit path: an expired staged job from
        ANY user is swept when the next submit arrives."""
        env, client = api["db"], api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        expired = ExtractionJob(
            id="expired-job",
            user_id=OTHER_USER_ID,
            status="done",
            original_filename="old.pdf",
            file_path="/static/uploads/gone.pdf",
            file_size=10,
            updated_at=datetime.now(timezone.utc) - timedelta(hours=200),
        )
        env.add(expired)
        env.commit()
        resp = await client.post("/api/import/jobs", files=_make_pdf())
        assert resp.status_code == 200
        env.rollback()
        assert env.query(ExtractionJob).filter(ExtractionJob.id == "expired-job").count() == 0


class TestListAndDetail:
    @pytest.mark.asyncio
    async def test_list_compact_fields_newest_first(self, api):
        env, client = api["db"], api["client"]
        now = datetime.now(timezone.utc)
        j1 = ExtractionJob(
            id="job-old", user_id=TEST_USER_ID, status="done",
            original_filename="old.pdf", file_path="/static/uploads/o.pdf",
            file_size=1, updated_at=now - timedelta(hours=1), created_at=now - timedelta(hours=1),
        )
        j2 = ExtractionJob(
            id="job-new", user_id=TEST_USER_ID, status="processing", stage="matching",
            progress={"stage": "matching", "biomarker_count": 3, "estimate_s": 2.0},
            original_filename="new.pdf", file_path="/static/uploads/n.pdf",
            file_size=2, created_at=now,
        )
        env.add_all([j1, j2])
        env.commit()
        resp = await client.get("/api/import/jobs")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert [i["id"] for i in items] == ["job-new", "job-old"]
        assert items[0]["status"] == "processing"
        assert items[0]["progress"] == {"stage": "matching", "biomarker_count": 3, "estimate_s": 2.0}
        assert items[0]["error"] is None
        # Only the caller's rows.
        assert all(i["id"] != "foreign" for i in items)

    @pytest.mark.asyncio
    async def test_detail_done_result_sse_shape(self, api):
        env, client = api["db"], api["client"]
        result = StandardizedMedicalRecord(
            entry_type="blood_test",
            date="2026-01-15",
            biomarkers=[],
        ).model_dump()
        job = ExtractionJob(
            id="job-done", user_id=TEST_USER_ID, status="done", result=result,
            original_filename="d.pdf", file_path="/static/uploads/d.pdf", file_size=5,
        )
        env.add(job)
        env.commit()
        resp = await client.get("/api/import/jobs/job-done")
        body = resp.json()
        assert body["status"] == "done"
        # Same shape as the SSE result event.
        assert body["result"]["entry_type"] == "blood_test"
        assert body["result"]["date"] == "2026-01-15"
        assert "biomarkers" in body["result"]

    @pytest.mark.asyncio
    async def test_detail_failed_localized_error(self, api):
        env, client = api["db"], api["client"]
        env.add(ExtractionJob(
            id="job-fail", user_id=TEST_USER_ID, status="failed",
            error_key="ai.ocr_quota", error_params={},
            original_filename="f.pdf", file_path="/static/uploads/f.pdf", file_size=5,
        ))
        env.commit()
        resp = await client.get(
            "/api/import/jobs/job-fail", headers={"Accept-Language": "ru"}
        )
        body = resp.json()
        assert body["status"] == "failed"
        assert "429" in body["error"]
        assert body["result"] is None

    @pytest.mark.asyncio
    async def test_tenant_scoped_404(self, api):
        env, client = api["db"], api["client"]
        env.add(ExtractionJob(
            id="job-foreign", user_id=OTHER_USER_ID, status="queued",
            original_filename="x.pdf", file_path="/static/uploads/x.pdf", file_size=5,
        ))
        env.commit()
        for path, method in [
            ("/api/import/jobs/job-foreign", "get"),
            ("/api/import/jobs/job-foreign/cancel", "post"),
            ("/api/import/jobs/job-foreign/retry", "post"),
            ("/api/import/jobs/job-foreign", "delete"),
        ]:
            resp = await client.request(method.upper(), path)
            assert resp.status_code == 404, (method, path)


class TestCancel:
    @pytest.mark.asyncio
    async def test_cancel_queued_refunds_and_deletes_file(self, api, monkeypatch):
        env, client, upload_dir = api["db"], api["client"], api["upload_dir"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        staged = os.path.join(upload_dir, "queued-job.pdf")
        with open(staged, "wb") as f:
            f.write(PDF_BYTES)
        resp = await client.post("/api/import/jobs", files=_make_pdf())
        job_id = resp.json()["job_id"]
        # Fix the staged file name to our known one for the assertion.
        row = env.query(ExtractionJob).filter(ExtractionJob.id == job_id).one()
        row.file_path = "/static/uploads/queued-job.pdf"
        env.commit()

        resp = await client.post(f"/api/import/jobs/{job_id}/cancel")
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"
        env.rollback()
        row = env.query(ExtractionJob).filter(ExtractionJob.id == job_id).one()
        assert row.status == "cancelled"
        assert _usage(env) == 0  # refunded
        assert not os.path.exists(staged)
        # Cancelled emits no notification.
        assert env.query(Notification).count() == 0

    @pytest.mark.asyncio
    async def test_cancel_processing_flags_worker_instead(self, api):
        env, client = api["db"], api["client"]
        env.add(ExtractionJob(
            id="job-proc", user_id=TEST_USER_ID, status="processing", stage="matching",
            original_filename="p.pdf", file_path="/static/uploads/p.pdf", file_size=5,
        ))
        env.add(UsageLimit(user_id="usage-proc", is_anonymous=False, ai_extraction_count=1))
        env.commit()
        resp = await client.post("/api/import/jobs/job-proc/cancel")
        assert resp.status_code == 200
        body = resp.json()
        assert body["cancel_requested"] is True
        env.rollback()
        row = env.query(ExtractionJob).filter(ExtractionJob.id == "job-proc").one()
        assert row.status == "processing"  # worker still owns it
        assert row.cancel_requested is True
        # No refund by the API — the worker owns a dequeued job's refund.
        usage = env.query(UsageLimit).filter(UsageLimit.user_id == "usage-proc").one()
        assert usage.ai_extraction_count == 1

    @pytest.mark.asyncio
    async def test_cancel_done_conflict(self, api):
        env, client = api["db"], api["client"]
        env.add(ExtractionJob(
            id="job-done", user_id=TEST_USER_ID, status="done",
            original_filename="d.pdf", file_path="/static/uploads/d.pdf", file_size=5,
        ))
        env.commit()
        resp = await client.post("/api/import/jobs/job-done/cancel")
        assert resp.status_code == 409


class TestRetry:
    @pytest.mark.asyncio
    async def test_retry_failed_recharges_and_requeues(self, api, monkeypatch, tmp_path):
        env, client, upload_dir = api["db"], api["client"], api["upload_dir"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        with open(os.path.join(upload_dir, "retry.pdf"), "wb") as f:
            f.write(PDF_BYTES)
        env.add(ExtractionJob(
            id="job-retry", user_id=TEST_USER_ID, status="failed",
            error_key="ai.ocr_quota", original_filename="r.pdf",
            file_path="/static/uploads/retry.pdf", file_size=5,
        ))
        env.commit()
        resp = await client.post("/api/import/jobs/job-retry/retry")
        assert resp.status_code == 200
        env.rollback()
        row = env.query(ExtractionJob).filter(ExtractionJob.id == "job-retry").one()
        assert row.status == "queued"
        assert row.error_key is None  # cleared
        assert _usage(env) == 1  # re-charged only via the winning transition

    @pytest.mark.asyncio
    async def test_retry_rejects_non_failed(self, api):
        env, client = api["db"], api["client"]
        env.add(ExtractionJob(
            id="job-run", user_id=TEST_USER_ID, status="processing",
            original_filename="x.pdf", file_path="/static/uploads/x.pdf", file_size=5,
        ))
        env.commit()
        resp = await client.post("/api/import/jobs/job-run/retry")
        assert resp.status_code == 409
        assert _usage(env) == 0  # no charge

    @pytest.mark.asyncio
    async def test_retry_missing_file(self, api, monkeypatch):
        env, client = api["db"], api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        env.add(ExtractionJob(
            id="job-gone", user_id=TEST_USER_ID, status="failed",
            original_filename="g.pdf", file_path="/static/uploads/never.pdf", file_size=5,
        ))
        env.commit()
        resp = await client.post("/api/import/jobs/job-gone/retry")
        assert resp.status_code == 400
        env.rollback()
        assert env.query(ExtractionJob).filter(ExtractionJob.id == "job-gone").one().status == "failed"
        assert _usage(env) == 0  # not charged

    @pytest.mark.asyncio
    async def test_retry_quota_429_rolls_back_transition(self, api, monkeypatch, tmp_path):
        env, client, upload_dir = api["db"], api["client"], api["upload_dir"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        with open(os.path.join(upload_dir, "q.pdf"), "wb") as f:
            f.write(PDF_BYTES)
        env.add(ExtractionJob(
            id="job-q", user_id=TEST_USER_ID, status="failed",
            original_filename="q.pdf", file_path="/static/uploads/q.pdf", file_size=5,
        ))
        _set_usage(env, 50)
        resp = await client.post("/api/import/jobs/job-q/retry")
        assert resp.status_code == 429
        env.rollback()
        row = env.query(ExtractionJob).filter(ExtractionJob.id == "job-q").one()
        assert row.status == "failed"  # transition rolled back with the charge
        assert _usage(env) == 50


class TestDismiss:
    @pytest.mark.asyncio
    async def test_dismiss_done_transitions_to_history(self, api):
        """Dismissing a done job keeps the row as a 'dismissed' history
        record (no refund — the extraction ran), frees the staged file, and
        deletes the job's notification rows."""
        env, client, upload_dir = api["db"], api["client"], api["upload_dir"]
        with open(os.path.join(upload_dir, "gone.pdf"), "wb") as f:
            f.write(PDF_BYTES)
        env.add(ExtractionJob(
            id="job-d", user_id=TEST_USER_ID, status="done",
            original_filename="d.pdf", file_path="/static/uploads/gone.pdf", file_size=5,
        ))
        # Retries produced two notifications for this job.
        for _ in range(2):
            env.add(Notification(
                id=uuid.uuid4().hex, user_id=TEST_USER_ID, job_id="job-d",
                type="import_job_failed", payload={"job_id": "job-d", "filename": "d.pdf"},
            ))
        env.commit()
        resp = await client.delete("/api/import/jobs/job-d")
        assert resp.status_code == 200
        env.rollback()
        row = env.query(ExtractionJob).filter(ExtractionJob.id == "job-d").one()
        assert row.status == "dismissed"
        assert _usage(env) == 0  # no refund for a done job
        assert env.query(Notification).filter(Notification.job_id == "job-d").count() == 0
        assert not os.path.exists(os.path.join(upload_dir, "gone.pdf"))

    @pytest.mark.asyncio
    async def test_dismiss_queued_refunds(self, api, monkeypatch):
        """Dismissing a queued job refunds — the extraction never ran
        (same rule as a queued cancel)."""
        env, client = api["db"], api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        monkeyish = await client.post("/api/import/jobs", files=_make_pdf())
        assert monkeyish.status_code == 200
        resp = await client.delete(f"/api/import/jobs/{monkeyish.json()['job_id']}")
        assert resp.status_code == 200
        env.rollback()
        row = env.query(ExtractionJob).filter(
            ExtractionJob.id == monkeyish.json()['job_id']
        ).one()
        assert row.status == "dismissed"
        assert _usage(env) == 0  # refunded

    @pytest.mark.asyncio
    async def test_dismiss_history_rows_conflict(self, api):
        """History rows (saved/cancelled/dismissed) cannot be dismissed —
        the UI offers no button there and rows cannot be removed."""
        env, client = api["db"], api["client"]
        for status in ("saved", "cancelled", "dismissed"):
            env.add(ExtractionJob(
                id=f"job-h-{status}", user_id=TEST_USER_ID, status=status,
                original_filename="h.pdf", file_path="/static/uploads/h.pdf", file_size=5,
            ))
        env.commit()
        for status in ("saved", "cancelled", "dismissed"):
            resp = await client.delete(f"/api/import/jobs/job-h-{status}")
            assert resp.status_code == 409, status
        env.rollback()
        assert env.query(ExtractionJob).filter(
            ExtractionJob.id.like("job-h-%")
        ).count() == 3

    @pytest.mark.asyncio
    async def test_dismiss_saved_conflict_keeps_the_attachments_file(self, api):
        """A saved job is history — dismiss is a 409 and its file (the saved
        entry's Attachment) obviously survives."""
        env, client, upload_dir = api["db"], api["client"], api["upload_dir"]
        with open(os.path.join(upload_dir, "adopted.pdf"), "wb") as f:
            f.write(PDF_BYTES)
        from app.db.models import Attachment, MedicalEntry

        entry = MedicalEntry(
            id="entry-adopted", patient_id=TEST_USER_ID, type="blood_test",
            date=datetime(2026, 1, 15, 10, 0), title="Panel",
        )
        env.add(entry)
        env.flush()
        env.add(Attachment(
            id="att-adopted", entry_id="entry-adopted", name="d.pdf",
            type="Uploaded Document", size="1 KB",
            file_path="/static/uploads/adopted.pdf",
        ))
        env.add(ExtractionJob(
            id="job-saved", user_id=TEST_USER_ID, status="saved",
            saved_entry_id="entry-adopted",
            original_filename="d.pdf", file_path="/static/uploads/adopted.pdf",
            file_size=5,
        ))
        env.commit()
        resp = await client.delete("/api/import/jobs/job-saved")
        assert resp.status_code == 409
        env.rollback()
        assert env.query(ExtractionJob).filter(ExtractionJob.id == "job-saved").one().status == "saved"
        # The file survives — the attachment still owns it.
        assert os.path.exists(os.path.join(upload_dir, "adopted.pdf"))

    @pytest.mark.asyncio
    async def test_dismiss_processing_flags_the_worker(self, api):
        """Dismissing a processing job flags cancel_requested (the worker
        owns a dequeued job) — it lands in history as cancelled."""
        env, client = api["db"], api["client"]
        env.add(ExtractionJob(
            id="job-busy-d", user_id=TEST_USER_ID, status="processing",
            original_filename="b.pdf", file_path="/static/uploads/b.pdf", file_size=5,
        ))
        env.commit()
        resp = await client.delete("/api/import/jobs/job-busy-d")
        assert resp.status_code == 200
        assert resp.json()["cancel_requested"] is True
        env.rollback()
        row = env.query(ExtractionJob).filter(ExtractionJob.id == "job-busy-d").one()
        assert row.status == "processing"
        assert row.cancel_requested is True

    @pytest.mark.asyncio
    async def test_dismiss_processing_conflict_removed(self, api):
        """(superseded — dismiss on processing now flags the worker; covered
        by test_dismiss_processing_flags_the_worker.)"""
        assert True


class TestAnonFlow:
    @pytest.mark.asyncio
    async def test_anon_submit_and_429_at_limit(self, anon_api, monkeypatch):
        env, client = anon_api["db"], anon_api["client"]
        monkeypatch.setattr(import_api, "_get_client", lambda: object())
        resp = await client.post("/api/import/jobs", files=_make_pdf())
        assert resp.status_code == 200
        job_id = resp.json()["job_id"]
        row = env.query(ExtractionJob).filter(ExtractionJob.id == job_id).one()
        assert row.user_id == "anon-import-user"
        assert row.is_anonymous is True
        assert _usage(env, "anon-import-user") == 1
        # Fill the anon quota (5) — the 6th document is rejected with the
        # existing localized anon detail.
        usage = env.query(UsageLimit).filter(UsageLimit.user_id == "anon-import-user").one()
        usage.ai_extraction_count = 5
        env.commit()
        resp = await client.post("/api/import/jobs", files=_make_pdf())
        assert resp.status_code == 429
        assert "register" in resp.json()["detail"].lower()


class TestStagedFileDownload:
    @pytest.mark.asyncio
    async def test_owner_downloads_staged_file(self, api):
        env, client, upload_dir = api["db"], api["client"], api["upload_dir"]
        with open(os.path.join(upload_dir, "staged-dl.pdf"), "wb") as f:
            f.write(PDF_BYTES)
        env.add(ExtractionJob(
            id="job-file", user_id=TEST_USER_ID, status="done",
            original_filename="Отчёт.pdf", file_path="/static/uploads/staged-dl.pdf",
            file_size=len(PDF_BYTES),
        ))
        env.commit()
        resp = await client.get("/api/import/jobs/job-file/file")
        assert resp.status_code == 200
        assert resp.content == PDF_BYTES
        # PDF preview in the review editor needs the right blob type.
        assert resp.headers["content-type"] == "application/pdf"
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert "attachment" in resp.headers["content-disposition"]

    @pytest.mark.asyncio
    async def test_staged_file_tenant_scoped_and_missing(self, api):
        env, client = api["db"], api["client"]
        env.add(ExtractionJob(
            id="job-foreign-file", user_id=OTHER_USER_ID, status="done",
            original_filename="x.pdf", file_path="/static/uploads/x.pdf", file_size=5,
        ))
        env.add(ExtractionJob(
            id="job-gone-file", user_id=TEST_USER_ID, status="done",
            original_filename="g.pdf", file_path="/static/uploads/never-there.pdf",
            file_size=5,
        ))
        env.commit()
        foreign = await client.get("/api/import/jobs/job-foreign-file/file")
        assert foreign.status_code == 404
        missing = await client.get("/api/import/jobs/job-gone-file/file")
        assert missing.status_code == 404
