#!/usr/bin/env python3
"""End-to-end acceptance harness for HealthPassport medical-document
standardization.

For each case under ``inputs/<case>/`` this script:
  1. POSTs the document to the live ``POST /api/extract`` endpoint,
  2. extracts the final ``result`` JSON from the SSE body (SSE is only used as
     a transport - progress/error framing is ignored except to capture errors),
  3. diffs it against the hand-verified golden ``golden/<case>/standardized.json``
     using the tolerant comparison rules in ``compare.py``.

It does NOT import the matcher or any app code - it is a pure HTTP client, so
the server is the system under test (and must have MISTRAL_API_KEY configured
and a seeded biomarker dictionary).

Usage
-----
  python run_e2e.py                       # run every discovered case
  python run_e2e.py --case my_lab         # run a single case
  python run_e2e.py --regen-golden        # write observed output as FOR-REVIEW golden
  python run_e2e.py --url http://host:8000/api/extract --token <jwt>

Exit code is non-zero if any *verified* golden mismatches (so it can gate CI).
Pending (not-yet-reviewed) cases are reported but do not fail the run.
"""

import argparse
import json
import os
import sys

import httpx
from compare import compare_standardized

HERE = os.path.dirname(os.path.abspath(__file__))
INPUTS_DIR = os.path.join(HERE, "inputs")
GOLDEN_DIR = os.path.join(HERE, "golden")

PENDING_STATUS = "PENDING VERIFICATION"
REVIEW_STATUS = "FOR REVIEW - not auto-accepted"

MIME_BY_EXT = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".bmp": "image/bmp",
}


def discover_cases():
    cases = []
    if not os.path.isdir(INPUTS_DIR):
        return cases
    for name in sorted(os.listdir(INPUTS_DIR)):
        cdir = os.path.join(INPUTS_DIR, name)
        if not os.path.isdir(cdir):
            continue
        files = [
            f for f in sorted(os.listdir(cdir))
            if os.path.isfile(os.path.join(cdir, f)) and not f.startswith(".")
        ]
        if files:
            cases.append((name, cdir, files))
    return cases


def extract_result(body):
    """Pull the ``event: result`` JSON out of an SSE body. Returns (json, error)."""
    last_error = None
    for block in body.split("\n\n"):
        event = None
        data_lines = []
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line[7:].strip()
            elif line.startswith("data: "):
                data_lines.append(line[6:])
        if not data_lines:
            continue
        payload = "\n".join(data_lines)
        if event == "result":
            return json.loads(payload), None
        if event == "error":
            try:
                err = json.loads(payload)
                last_error = err.get("message", payload)
            except json.JSONDecodeError:
                last_error = payload
    if last_error:
        return None, last_error
    return None, "No 'result' or 'error' event found in SSE body"


def call_extract(client, url, path, token):
    ext = os.path.splitext(path)[1].lower()
    mime = MIME_BY_EXT.get(ext, "application/octet-stream")
    with open(path, "rb") as fh:
        data = fh.read()
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # 15 min: a single /api/extract chains OCR + up to ~10 LLM calls; under
    # provider throttling each call can stretch to ~1 min. 300s produced
    # client-side cancels mid-extraction ("cancelled by client — quota
    # refunded") during degraded windows.
    resp = client.post(
        url,
        files={"file": (os.path.basename(path), data, mime)},
        headers=headers,
    )
    return resp.text


def main():
    ap = argparse.ArgumentParser(description="HealthPassport e2e golden harness")
    ap.add_argument("--url", default="http://localhost:8000/api/extract",
                    help="Full /api/extract URL (default: http://localhost:8000/api/extract)")
    ap.add_argument("--case", help="Run only this case (directory name under inputs/)")
    ap.add_argument("--token", help="Bearer JWT for a registered user (raises AI limit 5->20)")
    ap.add_argument("--regen-golden", action="store_true",
                    help="Write observed output to golden/<case>/standardized.json for review")
    ap.add_argument("--text-threshold", type=float, default=0.88,
                    help="Similarity threshold for free-text fields (default 0.88)")
    ap.add_argument("--dump-observed", help="Write observed output JSON to this path")
    args = ap.parse_args()

    cases = discover_cases()
    if args.case:
        cases = [c for c in cases if c[0] == args.case]
        if not cases:
            print(f"No case '{args.case}' found under {INPUTS_DIR}")
            return 2

    if not cases:
        print(f"No input cases found under {INPUTS_DIR}/.")
        print("Drop a PDF/image into backend/e2e/inputs/<case>/ and rerun.")
        return 0

    passed = pending = failed = 0
    # One HTTP client (and thus one cookie jar) for the whole run: the suite
    # simulates a SINGLE user uploading documents sequentially, so anonymous
    # sessions persist across cases and per-user local definitions
    # (first-seen anchoring + cross-document unification) behave exactly as
    # they do for a real account.
    with httpx.Client(timeout=900.0) as client:
        for name, cdir, files in cases:
            path = os.path.join(cdir, files[0])
            if len(files) > 1:
                print(f"[warn] case '{name}' has multiple files; using {files[0]}")
            print(f"\n=== Case: {name} ===")
            print(f"  input : {path}")

            try:
                body = call_extract(client, args.url, path, args.token)
            except Exception as exc:  # network / server down
                print(f"  ERROR calling endpoint: {exc}")
                failed += 1
                continue

            observed, err = extract_result(body)
            if err:
                print(f"  ENDPOINT ERROR: {err}")
                failed += 1
                continue

            if args.dump_observed:
                with open(args.dump_observed, "w", encoding="utf-8") as fh:
                    json.dump(observed, fh, indent=2, ensure_ascii=False)
                print(f"  wrote observed -> {args.dump_observed}")

            golden_path = os.path.join(GOLDEN_DIR, name, "standardized.json")
            pending_path = os.path.join(GOLDEN_DIR, name, "standardized.pending.json")

            if args.regen_golden:
                os.makedirs(os.path.dirname(golden_path), exist_ok=True)
                observed["_status"] = REVIEW_STATUS
                with open(golden_path, "w", encoding="utf-8") as fh:
                    json.dump(observed, fh, indent=2, ensure_ascii=False)
                print(f"  wrote FOR-REVIEW golden -> {golden_path}")
                pending += 1
                continue

            if not os.path.isfile(golden_path):
                os.makedirs(os.path.dirname(pending_path), exist_ok=True)
                observed["_status"] = PENDING_STATUS
                with open(pending_path, "w", encoding="utf-8") as fh:
                    json.dump(observed, fh, indent=2, ensure_ascii=False)
                print(f"  PENDING VERIFICATION (stub written) -> {pending_path}")
                pending += 1
                continue

            with open(golden_path, encoding="utf-8") as fh:
                golden = json.load(fh)
            if golden.get("_status") == PENDING_STATUS:
                print(f"  PENDING VERIFICATION (stub not yet reviewed) -> {golden_path}")
                pending += 1
                continue

            diffs = compare_standardized(observed, golden, args.text_threshold)
            if diffs:
                print(f"  MISMATCH ({len(diffs)} issue(s)):")
                for d in diffs:
                    print(f"    - {d}")
                failed += 1
            else:
                print("  PASS")
                passed += 1

    print(f"\n=== Summary: {passed} passed, {pending} pending, {failed} failed ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
