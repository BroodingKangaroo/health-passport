#!/usr/bin/env python3
"""End-to-end test for the DELETE /api/entry/{id} endpoint against a real
running uvicorn server.

Unlike the golden harness (backend/e2e/run_e2e.py) which validates the AI
extraction pipeline, this test exercises the full HTTP round trip for a single
non-LLM CRUD path:

    1. Boot an isolated uvicorn on a non-8000 port with its own sqlite DB.
    2. Register a fresh user via /api/auth/register.
    3. Log in via /api/auth/login to obtain a JWT.
    4. POST /api/entry with a real file upload (a blood test PDF).
    5. Assert the file landed on disk under static/uploads/<name>.
    6. Assert GET /api/usage/limits shows the storage counter increased by the
       uploaded size.
    7. GET /api/timeline to confirm the entry is present.
    8. DELETE /api/entry/{id} with the user's JWT.
    9. Assert the file is gone from disk.
    10. Assert the entry is gone from /api/timeline.
    11. Assert /api/usage/limits shows the storage counter decremented back to
        its starting value.

Exits 0 on success, non-zero on the first failed assertion. The server is
always torn down (by PID) on exit — never a blanket pkill — and the test DB
plus uploaded files live in a temp directory that's removed on success.

Usage
-----
    python backend/e2e/run_delete_e2e.py
    python backend/e2e/run_delete_e2e.py --port 8124
    python backend/e2e/run_delete_e2e.py --keep-artifacts   # keep DB+files for debugging
"""
import argparse
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Optional

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
VENV = os.path.join(BACKEND, "venv", "bin", "python")
DEFAULT_PORT = 8098  # 8099 is used by run_e2e_server.py
HEALTH_WAIT = 12    # seconds for uvicorn to boot


def _ok(msg: str) -> None:
    print(f"  \033[32m✓\033[0m {msg}")


def _fail(msg: str) -> "None":
    print(f"  \033[31m✗\033[0m {msg}", file=sys.stderr)
    sys.exit(1)


def _section(msg: str) -> None:
    print(f"\n\033[1m{msg}\033[0m")


def _wait_for_server(base: str, timeout: float = HEALTH_WAIT) -> None:
    """Poll the root until it returns 200 (or timeout)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(f"{base}/", timeout=2)
            if r.status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(0.25)
    _fail(f"server at {base} did not become healthy in {timeout}s")


def main() -> int:
    ap = argparse.ArgumentParser(description="Run delete-endpoint e2e against an isolated backend")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help=f"Isolated uvicorn port (default {DEFAULT_PORT}; never 8000)")
    ap.add_argument("--keep-artifacts", action="store_true",
                    help="Keep the temp DB and uploaded files after the run")
    args = ap.parse_args()

    if args.port == 8000:
        print("Refusing to use port 8000 — that's the user's dev server port.", file=sys.stderr)
        return 2

    # Isolated, temp DB and static/uploads. init_db() runs at server startup
    # and creates the tables against this DATABASE_URL.
    tmpdir = tempfile.mkdtemp(prefix="healthpassport_delete_e2e_")
    db_path = os.path.join(tmpdir, "delete_e2e.db")
    upload_dir = os.path.join(tmpdir, "static", "uploads")
    os.makedirs(upload_dir, exist_ok=True)

    env = dict(os.environ)
    env["DATABASE_URL"] = f"sqlite:///{db_path}"
    # The server reads UPLOAD_DIR from entries.py (absolute path relative to
    # backend/). Force it to use our temp dir by overriding STATIC_UPLOAD_DIR
    # is not exposed, so we let the server use its default but clean up
    # afterwards. The default UPLOAD_DIR is <backend>/static/uploads — we'll
    # expect files there and clean them up at the end.
    default_upload_dir = os.path.join(BACKEND, "static", "uploads")

    srv = subprocess.Popen(
        [VENV, "-m", "uvicorn", "app.main:app", "--port", str(args.port)],
        cwd=BACKEND,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    created_files: list[str] = []
    try:
        base = f"http://localhost:{args.port}"
        _wait_for_server(base)

        # -----------------------------------------------------------------
        # 1) Register a fresh user (must come BEFORE login)
        # -----------------------------------------------------------------
        _section("Register + login")
        email = f"delete-e2e-{int(time.time())}@example.com"
        password = "delete-e2e-pass-1234"
        reg = requests.post(
            f"{base}/api/auth/register",
            json={"email": email, "password": password, "name": "Delete E2E",
                  "dob": "1990-01-01", "gender": "Other", "migrate_data": False},
            timeout=5,
        )
        if reg.status_code != 201:
            _fail(f"register returned {reg.status_code}: {reg.text[:200]}")
        _ok("registered user")

        # 2) Log in to get a JWT
        login = requests.post(
            f"{base}/api/auth/login",
            data={"username": email, "password": password},
            timeout=5,
        )
        if login.status_code != 200:
            _fail(f"login returned {login.status_code}: {login.text[:200]}")
        token = login.json().get("access_token")
        if not token:
            _fail(f"login response missing access_token: {login.text[:200]}")
        _ok("logged in and obtained JWT")
        auth = {"Authorization": f"Bearer {token}"}

        # -----------------------------------------------------------------
        # 3) Baseline storage counter
        # -----------------------------------------------------------------
        _section("Baseline")
        lim0 = requests.get(f"{base}/api/usage/limits", headers=auth, timeout=5)
        if lim0.status_code != 200:
            _fail(f"GET /api/usage/limits returned {lim0.status_code}")
        baseline_bytes = lim0.json()["total_upload_size_bytes"]
        _ok(f"baseline total_upload_size_bytes = {baseline_bytes}")

        # -----------------------------------------------------------------
        # 4) Upload a real PDF file via POST /api/entry
        # -----------------------------------------------------------------
        _section("Upload entry with file")
        # Use a deterministic, non-trivial payload so the e2e catches size
        # math regressions even if the upload pipeline changes.
        file_bytes = b"%PDF-1.4\n%fake e2e delete test fixture\n" * 64
        expected_size = len(file_bytes)
        biomarkers_json = '[{"id":"cat-1","name":"CBC","rows":[]}]'
        upload = requests.post(
            f"{base}/api/entry",
            data={
                "type": "blood_test",
                "date": "2027-05-15",
                "clinic": "E2E Delete Lab",
                "title": "E2E Delete Test",
                "biomarkers": biomarkers_json,
            },
            files={"file": ("e2e_delete.pdf", file_bytes, "application/pdf")},
            headers=auth,
            timeout=10,
        )
        if upload.status_code != 200:
            _fail(f"POST /api/entry returned {upload.status_code}: {upload.text[:200]}")
        entry_id = upload.json().get("id")
        if not entry_id:
            _fail(f"POST /api/entry response missing id: {upload.text[:200]}")
        _ok(f"created entry {entry_id}")

        # Locate the attachment on disk and remember it for cleanup
        timeline = requests.get(f"{base}/api/timeline", headers=auth, timeout=5)
        if timeline.status_code != 200:
            _fail(f"GET /api/timeline after upload returned {timeline.status_code}")
        events = timeline.json()["events"]
        entry = next((e for e in events if e["id"] == entry_id), None)
        if entry is None:
            _fail(f"new entry {entry_id} not found in /api/timeline")
        if not entry.get("attachments"):
            _fail("new entry has no attachments in /api/timeline")
        att = entry["attachments"][0]
        if not att.get("url", "").startswith("/static/uploads/"):
            _fail(f"attachment url is unexpected: {att.get('url')!r}")
        filename = att["url"][len("/static/uploads/"):]
        on_disk = os.path.join(default_upload_dir, filename)
        if not os.path.isfile(on_disk):
            _fail(f"uploaded file not found on disk at {on_disk}")
        actual_size = os.path.getsize(on_disk)
        if actual_size != expected_size:
            _fail(f"file on disk is {actual_size} bytes, expected {expected_size}")
        _ok(f"file landed on disk at {on_disk} ({actual_size} bytes)")

        # Quota must have grown by exactly the file's byte size
        lim1 = requests.get(f"{base}/api/usage/limits", headers=auth, timeout=5)
        if lim1.status_code != 200:
            _fail(f"GET /api/usage/limits after upload returned {lim1.status_code}")
        after_upload_bytes = lim1.json()["total_upload_size_bytes"]
        if after_upload_bytes - baseline_bytes != expected_size:
            _fail(
                f"quota grew by {after_upload_bytes - baseline_bytes} bytes, "
                f"expected {expected_size}"
            )
        _ok(f"storage quota increased by {expected_size} bytes "
            f"({baseline_bytes} → {after_upload_bytes})")
        created_files.append(on_disk)

        # -----------------------------------------------------------------
        # 5) DELETE /api/entry/{id}
        # -----------------------------------------------------------------
        _section("Delete entry")
        delete = requests.delete(
            f"{base}/api/entry/{entry_id}",
            headers=auth,
            timeout=10,
        )
        if delete.status_code != 200:
            _fail(f"DELETE /api/entry/{entry_id} returned "
                  f"{delete.status_code}: {delete.text[:200]}")
        body = delete.json()
        if not body.get("success"):
            _fail(f"DELETE response success=false: {body}")
        if body.get("id") != entry_id:
            _fail(f"DELETE response id mismatch: {body}")
        if body.get("deleted_visit_data") is not False:
            _fail(f"DELETE response deleted_visit_data should be false for a blood_test, got {body}")
        if body.get("freed_bytes") != expected_size:
            _fail(f"DELETE response freed_bytes={body.get('freed_bytes')}, expected {expected_size}")
        _ok(f"DELETE returned 200, freed_bytes={body['freed_bytes']}")

        # -----------------------------------------------------------------
        # 6) Verify the file is gone from disk
        # -----------------------------------------------------------------
        _section("Post-delete assertions")
        if os.path.exists(on_disk):
            _fail(f"file still exists on disk after delete: {on_disk}")
        _ok("file is unlinked from disk")

        # 7) Entry gone from /api/timeline
        timeline2 = requests.get(f"{base}/api/timeline", headers=auth, timeout=5)
        if timeline2.status_code != 200:
            _fail(f"GET /api/timeline after delete returned {timeline2.status_code}")
        ids = [e["id"] for e in timeline2.json()["events"]]
        if entry_id in ids:
            _fail(f"entry {entry_id} still in /api/timeline after delete")
        _ok("entry removed from /api/timeline")

        # 8) Quota is back to baseline
        lim2 = requests.get(f"{base}/api/usage/limits", headers=auth, timeout=5)
        if lim2.status_code != 200:
            _fail(f"GET /api/usage/limits after delete returned {lim2.status_code}")
        after_delete_bytes = lim2.json()["total_upload_size_bytes"]
        if after_delete_bytes != baseline_bytes:
            _fail(
                f"quota after delete is {after_delete_bytes}, expected {baseline_bytes}"
            )
        _ok(f"storage quota back to baseline ({after_delete_bytes} bytes)")

        # 9) 404 on second delete
        del2 = requests.delete(
            f"{base}/api/entry/{entry_id}",
            headers=auth,
            timeout=5,
        )
        if del2.status_code != 404:
            _fail(f"second DELETE expected 404, got {del2.status_code}")
        _ok("second DELETE returns 404 (entry is gone)")

        print("\n\033[1;32mAll e2e delete assertions passed.\033[0m")
        return 0

    finally:
        # Tear down ONLY this server, by PID
        if srv.poll() is None:
            srv.send_signal(signal.SIGTERM)
            try:
                srv.wait(timeout=10)
            except subprocess.TimeoutExpired:
                srv.kill()
        # Cleanup uploaded file (if any) plus the temp DB
        for f in created_files:
            try:
                os.remove(f)
            except OSError:
                pass
        if not args.keep_artifacts:
            shutil.rmtree(tmpdir, ignore_errors=True)
        else:
            print(f"Artifacts kept at: {tmpdir}")


if __name__ == "__main__":
    sys.exit(main())
