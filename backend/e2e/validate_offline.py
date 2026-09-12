"""Offline, deterministic validation of the matcher against the hand-verified
goldens. Mirrors e2e/run_e2e.py but skips the live OCR+LLM extraction and the
live LLM matching steps (client=None), so it exercises only the deterministic
matching path (multilingual table + fuzzy + LOINC promotion). This isolates
matcher/data correctness from LLM nondeterminism and API availability.

Determinism (ISSUES.md F13): the guard runs against its OWN cold, LOINC-seeded
snapshot DB (default `e2e/validate_offline.db`) rather than the dev DB, using
the same seed + warm-up + golden-pinning pipeline as the benchmark. Anchor
drift from a warm dev DB can no longer change the guard's absolute numbers.
The similarity cutoff is unified with the benchmark default (0.9) via
``--text-threshold``.
"""
import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

INPUT_DIR = os.path.join(HERE, "inputs")
GOLDEN_DIR = os.path.join(HERE, "golden")
DEFAULT_DB = os.path.join(HERE, "validate_offline.db")
DEFAULT_SEED_DB = os.path.join(HERE, "validate_offline_seed.db")
DEFAULT_TEXT_THRESHOLD = 0.9


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="Deterministic matcher-only validation against e2e goldens")
    ap.add_argument("--db", default=DEFAULT_DB,
                    help="throwaway work sqlite DB (rebuilt every invocation)")
    ap.add_argument("--seed-db", default=DEFAULT_SEED_DB,
                    help="pinned LOINC-seeded base DB (fingerprint-cached)")
    ap.add_argument("--fresh-db", action="store_true",
                    help="force reseed of the pinned --seed-db")
    ap.add_argument("--text-threshold", type=float, default=DEFAULT_TEXT_THRESHOLD,
                    help="similarity cutoff (benchmark default 0.9)")
    return ap.parse_args(argv)


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


def _build_deterministic_db(db_path: str, seed_db: str, fresh: bool):
    """Rebuild the throwaway work DB from the pinned seed + full warm-up.

    The pinned ``--seed-db`` is LOINC-seeded once and never mutated; every
    invocation copies it, then applies the canonical `e2e/warmup_db` recipe
    (KNOWN_ISSUES.md Notes): replay EVERY golden with its verified
    ``standard_name_en`` and pin local names/units from golden truth. This is
    absolute and idempotent — the work DB never carries over a previous pass.
    """
    from benchmark.run_benchmark import ensure_seeded_db
    from e2e import warmup_db

    ensure_seeded_db(seed_db, fresh)
    for suffix in ("", "-wal", "-shm"):
        p = db_path + suffix
        if os.path.exists(p):
            os.remove(p)
    shutil.copyfile(os.path.abspath(seed_db), db_path)
    warmup_db.main()


def main(argv=None) -> int:
    args = parse_args(argv)

    from dotenv import load_dotenv

    load_dotenv(os.path.join(BACKEND, ".env"))
    os.environ["DATABASE_URL"] = f"sqlite:///{os.path.abspath(args.db)}"

    _build_deterministic_db(args.db, args.seed_db, args.fresh_db)

    from app.db.session import SessionLocal
    from app.schemas.ai import RawBiomarker, RawMedicalRecord
    from app.services.matcher import match_and_convert
    from e2e.compare import compare_standardized

    db = SessionLocal()
    failing_cases = 0
    total_diffs = 0
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
        diffs = compare_standardized(obs, golden, text_threshold=args.text_threshold)
        status = "PASS" if not diffs else f"FAIL ({len(diffs)})"
        print(f"[{status}] {name}")
        for d in diffs:
            print("   -", d)
        if diffs:
            failing_cases += 1
        total_diffs += len(diffs)
    db.close()
    print(f"\nTotal diffs: {total_diffs} (failing cases: {failing_cases})")
    return 1 if total_diffs else 0


if __name__ == "__main__":
    sys.exit(main())
