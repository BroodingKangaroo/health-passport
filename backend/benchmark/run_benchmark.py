#!/usr/bin/env python3
"""Extraction benchmark — THE loop verify command (ISSUES.md #24).

Runs the LIVE pipeline (OCR -> LLM extraction -> matcher) over the local
corpus (`benchmark/corpus/<case>/`, one source document + `standardized.json`
golden per case, same JSON format as the e2e goldens), N times per case,
against a cold snapshot DB, and prints machine-readable metrics:

    METRIC recognition=0.94
    METRIC stability=0.88
    METRIC primary=0.83
    METRIC llm_calls=9
    METRIC input_tokens=18430
    METRIC output_tokens=5210
    METRIC ocr_bytes=2415013
    METRIC wall_s=92.4

Isolation rules (mirrors validate_offline.py / e2e safety conventions):

- Pure library runner: NO server, NO port, NO HTTP.
- Own LOINC-seeded sqlite DB (`--db`, default benchmark_run.db) driven through
  DATABASE_URL BEFORE app imports; never touches health_passport.db.
- Its own Mistral client (production retry/timeout config), fresh per run,
  wrapped in benchmark.metrics.InstrumentedMistral for cost accounting.
- REAL Mistral spend on every invocation: ~len(cases) x N x (OCR + 1-9 LLM
  calls). See README.md for cost notes.

DB lifecycle ("cold snapshot per run"):

1. If the DB is missing (or --fresh-db) it is seeded via `python -m
   app.db.seed_loinc` into this benchmark's own DB (drop/recreate).
2. A deterministic warm-up pass replays the колонофлор_16_25.06 golden (the
   documented lg-anchor ordering dependency from e2e KNOWN_ISSUES.md) through
   the matcher with client=None on every rebuilt snapshot, so the canonical
   `copies/mL` (linear) anchors first exactly like the e2e convention.
3. That seeded+warm state is snapshotted (pristine file). Each of the N runs
   restores the snapshot first, so every run starts identically COLD —
   stability measures pure OCR/LLM nondeterminism, never def-warm-up state.

Exit codes: 0 = metrics computed (even when worse than baseline — the LOOP
decides keep/discard by comparing primary), 2 = hard failure (MISTRAL_API_KEY
missing, auth/quota errors), 1 = unexpected crash (traceback). This keeps the
loop's "worse" vs "broken" distinction from ISSUES.md #24 intact.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from benchmark.metrics import BenchmarkMetrics

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
# Script-dir imports won't resolve `app.*` / `e2e.*` namespace packages when
# invoked as `venv/bin/python benchmark/run_benchmark.py`; backend root must
# be importable before any lazy app import runs.
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)
CORPUS_DIR = os.path.join(HERE, "corpus")
E2E_INPUTS = os.path.join(BACKEND, "e2e", "inputs")
E2E_GOLDEN = os.path.join(BACKEND, "e2e", "golden")
VENV_PY = os.path.join(BACKEND, "venv", "bin", "python")
DEFAULT_DB = os.path.join(HERE, "benchmark_run.db")
PRISTINE_DB = os.path.join(HERE, "benchmark_pristine.db")
BENCHMARK_USER_ID = "default"

# Documented in e2e/KNOWN_ISSUES.md: on a fresh DB, alphabetical order anchors
# `lg копий/мл` -> log10 for the колонофлор analytes unless the 25.06 doc
# (empty raw units) lands FIRST and anchors linear `copies/mL`.
WARMUP_CASE = "колонофлор_16_25.06"


class BenchmarkBroken(Exception):
    """Hard failure: cannot produce comparable metrics (auth/quota/config)."""


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="HealthPassport extraction benchmark (live pipeline)")
    ap.add_argument("--runs", type=int, default=3, help="repeats per case (default 3)")
    ap.add_argument("--cases", help="comma-separated subset of case names")
    ap.add_argument("--db", default=DEFAULT_DB, help="benchmark sqlite DB path")
    ap.add_argument("--fresh-db", action="store_true", help="force reseed of the benchmark DB")
    ap.add_argument("--text-threshold", type=float, default=0.9,
                    help="similarity cutoff passed to the comparator (default 0.9)")
    ap.add_argument("--report", help="write a JSON report to this path")
    ap.add_argument("--seed-corpus", action="store_true",
                    help="copy current e2e inputs/goldens into benchmark/corpus/ and exit")
    args = ap.parse_args(argv)
    if args.runs < 1:
        ap.error("--runs must be >= 1")
    return args


def seed_corpus_from_e2e() -> int:
    """Copy the current e2e cases (inputs + verified goldens) into corpus/.

    Existing corpus files are never overwritten (e2e stays the source of
    truth only for seeding).
    """
    if not os.path.isdir(E2E_INPUTS):
        print(f"No e2e inputs found at {E2E_INPUTS}", file=sys.stderr)
        return 2
    copied = skipped = 0
    for name in sorted(os.listdir(E2E_INPUTS)):
        src_dir = os.path.join(E2E_INPUTS, name)
        if not os.path.isdir(src_dir):
            continue
        golden_src = os.path.join(E2E_GOLDEN, name, "standardized.json")
        dst_dir = os.path.join(CORPUS_DIR, name)
        os.makedirs(dst_dir, exist_ok=True)
        for f in sorted(os.listdir(src_dir)):
            if f.startswith("."):
                continue
            dest = os.path.join(dst_dir, f)
            if os.path.exists(dest):
                skipped += 1
                continue
            shutil.copyfile(os.path.join(src_dir, f), dest)
            copied += 1
        if os.path.isfile(golden_src):
            dest = os.path.join(dst_dir, "standardized.json")
            if os.path.exists(dest):
                skipped += 1
            else:
                shutil.copyfile(golden_src, dest)
                copied += 1
    print(f"[seed-corpus] copied {copied} file(s), skipped {skipped} existing; corpus: {CORPUS_DIR}")
    return 0


def load_corpus(subset=None):
    """[(name, input_path, golden_dict)] sorted; missing/goldenless cases error."""
    cases = []
    problems = []
    if not os.path.isdir(CORPUS_DIR):
        raise SystemExit(
            f"Corpus {CORPUS_DIR} is empty. Run with --seed-corpus to start from the e2e cases."
        )
    wanted = set(subset or [])
    for name in sorted(os.listdir(CORPUS_DIR)):
        cdir = os.path.join(CORPUS_DIR, name)
        if not os.path.isdir(cdir):
            continue
        if wanted and name not in wanted:
            continue
        files = [
            f for f in sorted(os.listdir(cdir))
            if os.path.isfile(os.path.join(cdir, f)) and not f.startswith(".")
            and f != "standardized.json"
        ]
        gpath = os.path.join(cdir, "standardized.json")
        if not files or not os.path.isfile(gpath):
            problems.append(name)
            continue
        with open(gpath, encoding="utf-8") as fh:
            golden = json.load(fh)
        cases.append((name, os.path.join(cdir, files[0]), golden))
    missing = wanted - {c[0] for c in cases}
    if missing:
        raise SystemExit(f"--cases not found in corpus: {sorted(missing)}")
    if problems:
        print(f"[warn] skipped malformed/incomplete corpus cases: {problems}", file=sys.stderr)
    if not cases:
        raise SystemExit("No runnable corpus cases.")
    return cases


def ensure_seeded_db(db_path: str, fresh: bool):
    """Guarantee a LOINC-seeded sqlite at db_path (seed drops & recreates)."""
    if os.path.exists(db_path) and not fresh:
        return False
    if os.path.exists(db_path):
        for suffix in ("", "-wal", "-shm"):
            p = db_path + suffix
            if os.path.exists(p):
                os.remove(p)
    env = dict(os.environ)
    env["DATABASE_URL"] = f"sqlite:///{os.path.abspath(db_path)}"
    env["PYTHONUNBUFFERED"] = "1"
    print(f"[seed] seeding LOINC dictionary into {db_path} ...")
    py = VENV_PY if os.path.exists(VENV_PY) else sys.executable
    seed = subprocess.run(
        [py, "-m", "app.db.seed_loinc"],
        cwd=BACKEND,
        env=env,
        input="yes\n",
        text=True,
    )
    if seed.returncode != 0:
        raise BenchmarkBroken(f"seed_loinc failed with exit {seed.returncode}")
    return True


def _pin_local_defs_from_goldens(goldens: list[dict]) -> int:
    """Deterministic golden-truth completion of user-default local defs.

    Mirrors ``e2e/warmup_db.py``: after the raw replay, definitions created
    client=None can't know the English display names / canonical units that a
    live extraction would have committed (translator + scale decisions).
    Without pinning, both колонофлор cases deterministically drop ~8 rows per
    run (split '' / lg-копий/мл anchors across spelling variants never equal
    the goldens' copies/mL truth). Runs once at snapshot-build time so every
    restored pristine DB carries identical warmth.
    """
    from app.db.models import BiomarkerDefinition
    from app.db.session import SessionLocal
    from e2e.warmup_db import USER_ID as WARMUP_USER_ID
    from e2e.warmup_db import _translate_unit

    golden_by_raw: dict[str, dict] = {}
    for g in goldens:
        for b in g.get("biomarkers", []):
            key = (b.get("raw_name") or "").strip().lower()
            if key:
                golden_by_raw[key] = b
    db = SessionLocal()
    fixed = 0
    try:
        rows = db.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.scope == "local",
            BiomarkerDefinition.user_id == WARMUP_USER_ID,
        ).all()
        for d in rows:
            candidates = [d.names.get("en") or "", *(d.synonyms or [])]
            g = next((golden_by_raw[c.strip().lower()] for c in candidates
                      if c and c.strip().lower() in golden_by_raw), None)
            if g is None:
                continue
            en = (g.get("standard_name_en") or "").strip()
            if en and en.isascii():
                names = dict(d.names or {})
                if names.get("en") != en:
                    names["en"] = en
                    d.names = names
                    if en not in (d.synonyms or []):
                        d.synonyms = [*list(d.synonyms or []), en]
            su = (g.get("standard_unit") or "").strip()
            cu = (d.canonical_unit or "").strip()
            kind = "log10" if su.lower().startswith(("lg", "log")) else "linear"
            new_unit = su if su and su.isascii() else (
                _translate_unit(cu)[0] if cu and not cu.isascii() else cu)
            if not new_unit or new_unit == cu:
                if not kind or d.canonical_kind == kind:
                    continue
                d.canonical_kind = kind
                fixed += 1
                continue
            d.canonical_unit = new_unit
            d.canonical_kind = kind
            fixed += 1
        db.commit()
    finally:
        db.close()
    return fixed


def build_pristine_snapshot(db_path: str, warmup_goldens: list[dict],
                            all_goldens: Optional[list[dict]] = None) -> str:
    """Prepare pristine.db: seeded schema + deterministic warm-up anchor pass."""
    from app.db.session import SessionLocal, init_db
    from app.schemas.ai import RawBiomarker, RawMedicalRecord
    from app.services.matcher import match_and_convert

    init_db()

    # Warm-up: replay golden RAW rows through the matcher with client=None.
    # Deterministic (matcher-only path, see validate_offline.py) and free;
    # anchors canonical units in the documented order.
    db = SessionLocal()
    try:
        if warmup_goldens:
            for golden in warmup_goldens:
                bm = [
                    RawBiomarker(
                        name=b.get("raw_name", ""),
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
                defs = _load_definitions(db)
                match_and_convert(raw, defs, db, BENCHMARK_USER_ID, None)
                db.commit()
    finally:
        db.close()

    # Golden-truth completion of the replayed locals (EN display names +
    # canonical units) — see _pin_local_defs_from_goldens. Applied BEFORE the
    # snapshot copy so every run/iteration starts from identical warmth.
    if all_goldens:
        pinned = _pin_local_defs_from_goldens(all_goldens)
        print(f"[snapshot] pinned {pinned} local defs from golden truth")

    pristine = PRISTINE_DB
    for suffix in ("-wal", "-shm"):
        p = pristine + suffix
        if os.path.exists(p):
            os.remove(p)
    from app.db.session import engine
    engine.dispose()  # flush all pooled connections before copying
    shutil.copyfile(os.path.abspath(db_path), pristine)
    if warmup_goldens:
        print(f"[snapshot] pristine with {len(warmup_goldens)} warm-up anchor(s) -> {pristine}")
    return pristine


def _load_definitions(db):
    from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel

    defs = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.scope == "global")
        | (BiomarkerDefinitionModel.user_id == BENCHMARK_USER_ID)
        | (BiomarkerDefinitionModel.user_id.is_(None))
    ).all()
    defs.sort(key=lambda d: (d.category or "", d.names.get("en", "") or ""))
    return defs


def restore_snapshot(pristine: str, db_path: str):
    """Cold-restore: drop cached connections, replace the live DB file."""
    from app.db.session import engine

    engine.dispose()
    for suffix in ("-wal", "-shm"):
        p = db_path + suffix
        if os.path.exists(p):
            os.remove(p)
    shutil.copyfile(pristine, os.path.abspath(db_path))


def _unknown_shape(raw) -> dict:
    from app.schemas.ai import RawInstrumentalData, StandardizedMedicalRecord, StandardizedVisitData

    return StandardizedMedicalRecord(
        entry_type="unknown",
        date=raw.date,
        time=raw.time,
        clinic=raw.clinic,
        provider=raw.provider,
        title=raw.title,
        notes=raw.notes,
        biomarkers=[],
        visit_data=StandardizedVisitData(),
        instrumental_data=RawInstrumentalData(),
    ).model_dump()


def run_once(cases, threshold: float) -> tuple[dict, "BenchmarkMetrics", float]:
    """One full verification pass over all cases. Returns results+metrics+wall."""
    from app.db.session import SessionLocal
    from app.services.extractor import OCRProcessingError, llm_extract, ocr_document
    from app.services.matcher import match_and_convert
    from benchmark.metrics import BenchmarkMetrics, make_instrumented_client

    metrics = BenchmarkMetrics()
    wrapped = make_instrumented_client(metrics)
    db = SessionLocal()
    results: dict[str, dict] = {}
    wall_start = time.perf_counter()
    try:
        for name, input_path, golden in cases:
            with open(input_path, "rb") as fh:
                data = fh.read()
            ext = os.path.splitext(input_path)[1].lower()

            t0 = time.perf_counter()
            try:
                markdown = ocr_document(data, ext, wrapped)
            except OCRProcessingError as err:
                if err.kind in ("auth", "quota"):
                    raise BenchmarkBroken(f"{name}: OCR {err.kind} — {err.message}") from err
                raise
            metrics.record_stage("ocr_s", time.perf_counter() - t0)

            t0 = time.perf_counter()
            raw = llm_extract(markdown, wrapped)
            metrics.record_stage("extract_s", time.perf_counter() - t0)

            t0 = time.perf_counter()
            if raw.entry_type == "unknown":
                observed = _unknown_shape(raw)
                db.commit()
            else:
                # Fresh definitions query per case, mirroring the server's
                # per-request query — defs created by earlier cases in this
                # run participate in later matches.
                observed = match_and_convert(
                    raw, _load_definitions(db), db, BENCHMARK_USER_ID, wrapped
                ).model_dump()
                db.commit()
            metrics.record_stage("match_s", time.perf_counter() - t0)

            from e2e.compare import compare_standardized

            diffs = compare_standardized(observed, golden, threshold)
            result = results.setdefault(
                name, {"input": input_path, "runs_diffs": [], "observed": []}
            )
            result["runs_diffs"].append(diffs)
            result["observed"].append(observed)
        return results, metrics, time.perf_counter() - wall_start
    finally:
        db.close()


def main(argv=None) -> int:
    args = parse_args(argv)

    if args.seed_corpus:
        return seed_corpus_from_e2e()

    from dotenv import load_dotenv

    load_dotenv(os.path.join(BACKEND, ".env"))
    os.environ["DATABASE_URL"] = f"sqlite:///{os.path.abspath(args.db)}"

    if not os.environ.get("MISTRAL_API_KEY"):
        print("BROKEN: MISTRAL_API_KEY is not configured (backend/.env)", file=sys.stderr)
        return 2

    cases = load_corpus(
        [c.strip() for c in args.cases.split(",")] if args.cases else None
    )

    ensure_seeded_db(args.db, args.fresh_db)

    # Warm-up anchor goldens (documented lg-anchor ordering fix).
    warmup = []
    wanted_warmup = None
    for name, _path, golden in cases:
        if name == WARMUP_CASE:
            wanted_warmup = golden
            break
    if wanted_warmup is not None:
        warmup.append(wanted_warmup)
    elif not args.cases:
        print(
            f"[warn] corpus lacks the '{WARMUP_CASE}' warm-up case — "
            "unit-anchor ordering caveat (see e2e/KNOWN_ISSUES.md) is unhandled",
            file=sys.stderr,
        )

    # Pin from the FULL corpus goldens even on --cases subsets: a subset
    # probe must restore the same snapshot warmth a full run would have.
    _all_corpus = load_corpus(None)
    pristine = build_pristine_snapshot(
        args.db, warmup, all_goldens=[g for _n, _p, g in _all_corpus]
    )

    from benchmark.scoring import aggregate, case_scores

    print(
        f"[run] {args.runs} run(s) x {len(cases)} case(s); "
        f"threshold={args.text_threshold}; corpus={CORPUS_DIR}"
    )
    results: dict[str, dict] = {}
    totals_runs_metrics = []
    total_wall = 0.0
    for _r in range(1, args.runs + 1):
        restore_snapshot(pristine, args.db)
        res, m, wall = run_once(cases, args.text_threshold)
        total_wall += wall
        totals_runs_metrics.append(m)
        for name, item in res.items():
            entry = results.setdefault(name, {"input": item["input"], "runs_diffs": []})
            entry["runs_diffs"].append(item["runs_diffs"][0])

    scores = {}
    for name, entry in results.items():
        golden = next((g for n, _p, g in cases if n == name), {})
        sc = case_scores(golden, entry["runs_diffs"])
        sc["input"] = entry["input"]
        scores[name] = sc
        unstable = ", ".join(sc["unstable_items"]) or "-"
        print(
            f"[{name}] universe={sc['universe_size']} "
            f"per_run_rec={[round(v, 3) for v in sc['per_run_recognition']]} "
            f"recognition={sc['recognition']:.3f} stability={sc['stability']:.3f} "
            f"extras={sc['extras_total']} unstable={unstable}"
        )
        if sc["top_diffs"]:
            print(f"[{name}] top_level diffs: {len(sc['top_diffs'])}")
        if sc["unclassified"]:
            print(
                f"[{name}] WARN {len(sc['unclassified'])} unclassified diff(s) — scoring.py parser",
                file=sys.stderr,
            )
            for u in sc["unclassified"]:
                print(f"    ? {u}", file=sys.stderr)

    agg = aggregate(scores)
    from benchmark.metrics import BenchmarkMetrics

    tot = BenchmarkMetrics()
    for m in totals_runs_metrics:
        tot.merge(m)

    wall = round(total_wall, 2)
    print("\n--- METRICS ---")
    print(f"METRIC recognition={agg['recognition']:.4f}")
    print(f"METRIC stability={agg['stability']:.4f}")
    print(f"METRIC primary={agg['primary']:.4f}")
    print(f"METRIC llm_calls={tot.llm_calls}")
    print(f"METRIC input_tokens={tot.prompt_tokens}")
    print(f"METRIC output_tokens={tot.completion_tokens}")
    print(f"METRIC ocr_bytes={max(tot.upload_bytes, tot.ocr_doc_bytes)}")
    print(f"METRIC wall_s={wall}")

    if args.report:
        report = {
            "config": {
                "runs": args.runs,
                "text_threshold": args.text_threshold,
                "cases": [c[0] for c in cases],
                "db": args.db,
            },
            "aggregate": agg,
            "metrics": tot.to_dict(),
            "wall_s": wall,
            "cases": {
                name: {
                    "input": sc["input"],
                    "universe_size": sc["universe_size"],
                    "recognition": round(sc["recognition"], 4),
                    "stability": round(sc["stability"], 4),
                    "extras_total": sc["extras_total"],
                    "per_run_recognition": [round(v, 4) for v in sc["per_run_recognition"]],
                    "unstable_items": sc["unstable_items"],
                }
                for name, sc in scores.items()
            },
        }
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, ensure_ascii=False)
        print(f"[report] wrote {args.report}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BenchmarkBroken as e:
        print(f"BROKEN: {e}", file=sys.stderr)
        sys.exit(2)
