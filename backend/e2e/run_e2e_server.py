#!/usr/bin/env python3
"""Boot an isolated backend, run the e2e golden harness against it, then tear
down ONLY that server process.

The golden harness (``run_e2e.py``) is a pure HTTP client — it never starts or
stops a server. Doing that by hand usually means a blanket ``pkill -f uvicorn``,
which kills any dev server the user already has running (typically on :8000).
This script avoids that: it spawns its own uvicorn on an isolated port with its
own DB, runs the harness, and kills just that one process by PID.

Usage
-----
    python run_e2e_server.py                 # default port 8099, db e2e_run.db
    python run_e2e_server.py --port 8123 --db /tmp/my.db
    python run_e2e_server.py --case оак_26.05 --regen-golden
    python run_e2e_server.py --url-token <jwt>   # reuse a caller-supplied token

The DB is seeded via ``python -m app.db.seed_loinc`` (LOINC dictionary =
single source of truth) on first run; subsequent runs reuse the existing DB.
Set DATABASE_URL externally to override the DB location entirely.
"""

import argparse
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(HERE, "..", "venv", "bin", "python")
DEFAULT_PORT = 8099
DEFAULT_DB = os.path.join(HERE, "e2e_run.db")
HEALTH_WAIT = 12  # seconds for uvicorn to boot


def _read_token() -> str:
    backend = os.path.join(HERE, "..")
    out = subprocess.run(
        [VENV, "-c",
         "from app.auth import create_access_token;"
         "print(create_access_token(data={'sub':'default','email':'alexey@example.com'}))"],
        cwd=backend,
        env=dict(os.environ),
        capture_output=True,
        text=True,
    )
    if out.returncode != 0 or not out.stdout.strip():
        raise RuntimeError(f"token generation failed: {out.stderr}")
    return out.stdout.strip()


def main():
    ap = argparse.ArgumentParser(description="Run e2e golden harness on an isolated backend")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help=f"Isolated uvicorn port (default {DEFAULT_PORT}; never 8000)")
    ap.add_argument("--db", default=DEFAULT_DB,
                    help=f"DB file for the isolated server (default {DEFAULT_DB})")
    ap.add_argument("--case", help="Forwarded to run_e2e.py (single case)")
    ap.add_argument("--regen-golden", action="store_true",
                    help="Forwarded to run_e2e.py (regenerate golden)")
    ap.add_argument("--text-threshold", type=float, default=0.88)
    ap.add_argument("--token", help="Bearer JWT (generated if omitted)")
    ap.add_argument("--dump-observed", help="Forwarded to run_e2e.py (write observed JSON)")
    args = ap.parse_args()

    if args.port == 8000:
        print("Refusing to use port 8000 — that's the user's dev server port.", file=sys.stderr)
        return 2

    db_path = os.path.abspath(args.db)
    env = dict(os.environ)
    env["DATABASE_URL"] = f"sqlite:///{db_path}"

    # Seed the LOINC dictionary only if the DB doesn't already exist.
    if not os.path.exists(db_path):
        print(f"Seeding LOINC dictionary into {db_path} ...")
        seed = subprocess.run(
            [VENV, "-m", "app.db.seed_loinc"],
            cwd=os.path.join(HERE, ".."),
            env={**env, "PYTHONUNBUFFERED": "1"},
            input="yes\n",
            text=True,
        )
        if seed.returncode != 0:
            print("seed_loinc failed; see output above", file=sys.stderr)
            return seed.returncode

    # Boot an isolated uvicorn.
    srv = subprocess.Popen(
        [VENV, "-m", "uvicorn", "app.main:app", "--port", str(args.port)],
        cwd=os.path.join(HERE, ".."),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(HEALTH_WAIT)
        if srv.poll() is not None:
            print("Server exited early; check logs.", file=sys.stderr)
            return 1

        token = args.token or _read_token()
        cmd = [
            VENV, os.path.join(HERE, "run_e2e.py"),
            "--url", f"http://localhost:{args.port}/api/extract",
            "--token", token,
            "--text-threshold", str(args.text_threshold),
        ]
        if args.case:
            cmd += ["--case", args.case]
        if args.regen_golden:
            cmd.append("--regen-golden")
        if args.dump_observed:
            cmd += ["--dump-observed", args.dump_observed]
        rc = subprocess.run(cmd, cwd=HERE).returncode
        return rc
    finally:
        # Tear down ONLY this server (by PID), never a blanket pkill.
        if srv.poll() is None:
            srv.send_signal(signal.SIGTERM)
            try:
                srv.wait(timeout=10)
            except subprocess.TimeoutExpired:
                srv.kill()


if __name__ == "__main__":
    sys.exit(main())
