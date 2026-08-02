"""Offline, deterministic validation of the matcher against the hand-verified
goldens. Mirrors e2e/run_e2e.py but skips the live OCR+LLM extraction and the
live LLM matching steps (client=None), so it exercises only the deterministic
matching path (multilingual table + fuzzy + LOINC promotion). This isolates
matcher/data correctness from LLM nondeterminism and API availability.
"""
# ruff: noqa: E402 -- load_dotenv() must run before importing app.db.session,
# which reads DATABASE_URL from the environment at import time.
import json
import os
import sys

from dotenv import load_dotenv

load_dotenv()

from app.db.session import SessionLocal
from app.schemas.ai import RawBiomarker, RawMedicalRecord
from app.services.matcher import match_and_convert
from e2e.compare import compare_standardized

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT_DIR = os.path.join(ROOT, "e2e", "inputs")
GOLDEN_DIR = os.path.join(ROOT, "e2e", "golden")


def _load_cases():
    cases = []
    for name in sorted(os.listdir(INPUT_DIR)):
        gpath = os.path.join(GOLDEN_DIR, name, "standardized.json")
        if not os.path.isfile(gpath):
            continue
        with open(gpath, encoding="utf-8") as f:
            golden = json.load(f)
        cases.append((name, golden))
    return cases


def main():
    db = SessionLocal()
    total_fail = 0
    for name, golden in _load_cases():
        bm = [
            RawBiomarker(
                name=b["raw_name"],
                value=b.get("raw_value", ""),
                unit=b.get("raw_unit", ""),
                raw_range_string=b.get("raw_range_string", ""),
                category=b.get("category"),
            )
            for b in golden.get("biomarkers", [])
        ]
        raw = RawMedicalRecord(
            entry_type=golden.get("entry_type", "blood_test"),
            date=golden.get("date", ""),
            time=golden.get("time", ""),
            clinic=golden.get("clinic", ""),
            provider=golden.get("provider", ""),
            title=golden.get("title", ""),
            notes=golden.get("notes", ""),
            biomarkers=bm,
        )
        result = match_and_convert(raw, [], db, "default", None)
        obs = result.model_dump()
        diffs = compare_standardized(obs, golden, text_threshold=0.85)
        status = "PASS" if not diffs else f"FAIL ({len(diffs)})"
        print(f"[{status}] {name}")
        for d in diffs:
            print("   -", d)
        total_fail += len(diffs)
    db.close()
    print("\nTotal diffs:", total_fail)
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
