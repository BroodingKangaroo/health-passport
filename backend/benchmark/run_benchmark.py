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
    METRIC wall_clock_s=31.2
    METRIC fallback_extractions=0
    METRIC provider_error_calls=0
    METRIC stage_ocr_s=8.1
    METRIC stage_extract_s=11.3
    METRIC stage_match_s=30.0

``wall_s`` stays the SUM of run walls (provider latency; the cost guard's
input); ``wall_clock_s`` is the invocation's wall-clock (smaller when runs
execute in parallel). ``fallback_extractions`` / ``provider_error_calls``
are the pollution counters — any count > 0 marks the run environment-
suspect for the loop (SKILL.md), never keep/discard material.

Parallelism: with ``--jobs > 1`` each run executes in its own subprocess
with a DB copy restored from the shared pristine snapshot (runs are
perfectly isolated; results are identical to sequential execution). Within
a run, ``--stage-concurrency`` fans the DB-free stages (OCR + LLM
extraction) out across cases; the matcher stays strictly sequential in
sorted case order so definition-creation ordering keeps its documented
semantics.

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
import contextlib
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
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

# Ceiling for --stage-concurrency: each in-flight OCR/LLM call occupies one
# worker of the module-level watchdog pool in benchmark.metrics (size 8), so
# fan-out beyond that would silently serialize on pool acquire.
MAX_STAGE_CONCURRENCY = 8

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
    ap.add_argument("--jobs", type=int, default=3,
                    help="runs executed in parallel as isolated subprocesses, each with "
                         "its own DB copy (default 3; 1 = in-process sequential)")
    ap.add_argument("--stage-concurrency", type=int, default=2,
                    help="concurrent OCR+extraction calls per run; the matcher stays "
                         f"sequential (default 2, max {MAX_STAGE_CONCURRENCY})")
    ap.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--pristine", default=PRISTINE_DB, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    if args.runs < 1:
        ap.error("--runs must be >= 1")
    if args.jobs < 1:
        ap.error("--jobs must be >= 1")
    if not 1 <= args.stage_concurrency <= MAX_STAGE_CONCURRENCY:
        ap.error(f"--stage-concurrency must be 1..{MAX_STAGE_CONCURRENCY} (watchdog pool size)")
    if args.child and (args.seed_corpus or args.fresh_db):
        ap.error("--seed-corpus/--fresh-db are parent-only flags")
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


def _is_fallback_record(raw) -> bool:
    """True when llm_extract ended in its silent failure record (LLM call
    failed or output unparseable): entry_type 'unknown' plus the canned
    'Raw OCR text:' notes. A model-chosen 'unknown' classification carries
    real notes and does NOT count — only genuine failures do (pollution
    guard, see SKILL.md)."""
    return raw.entry_type == "unknown" and (raw.notes or "").startswith("Raw OCR text:")


def _extract_all(cases, worker, stage_concurrency: int) -> dict:
    """Run ``worker(name, input_path) -> (name, raw)`` over all cases; fan out
    with a bounded pool when ``stage_concurrency > 1``. Any worker failure
    cancels not-yet-started siblings before propagating, so a doomed run
    stops spending immediately; in-flight calls finish or hit the
    SDK/watchdog timeouts."""
    raws: dict[str, object] = {}
    if stage_concurrency > 1 and len(cases) > 1:
        from concurrent.futures import ThreadPoolExecutor, as_completed

        with ThreadPoolExecutor(max_workers=stage_concurrency) as pool:
            futures = {
                pool.submit(worker, name, input_path): name
                for name, input_path, _golden in cases
            }
            try:
                for fut in as_completed(futures):
                    name, raw = fut.result()
                    raws[name] = raw
            except BaseException:
                for f in futures:
                    f.cancel()
                raise
    else:
        for name, input_path, _golden in cases:
            _n, raw = worker(name, input_path)
            raws[name] = raw
    return raws


def run_once(cases, threshold: float,
             stage_concurrency: int = 1) -> tuple[dict, "BenchmarkMetrics", float]:
    """One full verification pass over all cases. Returns results+metrics+wall.

    Phase 1 fans OCR + llm_extract out across cases (both DB-free and
    case-independent — see _extract_all). Phase 2 runs the matcher STRICTLY
    in sorted case order: definitions created by earlier cases must
    participate in later matches (same semantics as the sequential runner).
    """
    from app.db.session import SessionLocal
    from app.services.extractor import OCRProcessingError, llm_extract, ocr_document
    from app.services.matcher import match_and_convert
    from benchmark.metrics import BenchmarkMetrics, make_instrumented_client

    metrics = BenchmarkMetrics()
    wrapped = make_instrumented_client(metrics)
    db = SessionLocal()
    results: dict[str, dict] = {}
    wall_start = time.perf_counter()

    def _ocr_and_extract(name: str, input_path: str):
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
        if _is_fallback_record(raw):
            metrics.add_fallback_extraction()
        return name, raw

    try:
        raws = _extract_all(cases, _ocr_and_extract, stage_concurrency)

        from e2e.compare import compare_standardized

        for name, input_path, golden in cases:
            raw = raws[name]
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

            diffs = compare_standardized(observed, golden, threshold)
            result = results.setdefault(
                name, {"input": input_path, "runs_diffs": [], "observed": []}
            )
            result["runs_diffs"].append(diffs)
            result["observed"].append(observed)
        return results, metrics, time.perf_counter() - wall_start
    finally:
        db.close()


def _finalize(args, cases, runs_diffs: dict[str, list], tot_metrics, total_wall: float,
              wall_clock_s: float, chat_failovers: Optional[int] = None) -> int:
    """Score merged runs_diffs, print per-case lines + the METRICS block and
    write the report. Shared by the parent's in-process and parallel paths
    (and by --child, whose stdout the parent captures).

    ``wall_s`` keeps its documented semantic — the SUM of run walls (provider
    latency, scheduling-independent, the cost guard's input). ``wall_clock_s``
    is the additive human-facing wall-clock of the whole invocation.
    """
    from benchmark.scoring import aggregate, case_scores

    inputs = {name: path for name, path, _g in cases}
    scores = {}
    for name, runs in runs_diffs.items():
        golden = next((g for n, _p, g in cases if n == name), {})
        sc = case_scores(golden, runs)
        sc["input"] = inputs.get(name)
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

    wall = round(total_wall, 2)
    print("\n--- METRICS ---")
    print(f"METRIC recognition={agg['recognition']:.4f}")
    print(f"METRIC stability={agg['stability']:.4f}")
    print(f"METRIC primary={agg['primary']:.4f}")
    print(f"METRIC llm_calls={tot_metrics.llm_calls}")
    print(f"METRIC input_tokens={tot_metrics.prompt_tokens}")
    print(f"METRIC output_tokens={tot_metrics.completion_tokens}")
    print(f"METRIC ocr_bytes={max(tot_metrics.upload_bytes, tot_metrics.ocr_doc_bytes)}")
    print(f"METRIC wall_s={wall}")
    print(f"METRIC wall_clock_s={round(wall_clock_s, 2)}")
    print(f"METRIC fallback_extractions={tot_metrics.fallback_extractions}")
    print(f"METRIC provider_error_calls={tot_metrics.provider_error_calls}")
    # Cross-provider failovers (mistral call failed post-retry → served by
    # OpenRouter). Pollution-guard signal: >0 means mixed-provider weather.
    # Children report their own count; the in-process/child path reads the
    # local module counter.
    if chat_failovers is None:
        with contextlib.suppress(Exception):
            from app.services.chat_client import chat_failover_events
            chat_failovers = chat_failover_events()
    print(f"METRIC chat_failovers={chat_failovers or 0}")
    for k, v in tot_metrics.stage_seconds.items():
        print(f"METRIC stage_{k}={round(v, 2)}")

    if args.report:
        report = {
            "config": {
                "runs": args.runs,
                "jobs": args.jobs,
                "stage_concurrency": args.stage_concurrency,
                "text_threshold": args.text_threshold,
                "cases": [c[0] for c in cases],
                "db": args.db,
            },
            "aggregate": agg,
            "metrics": tot_metrics.to_dict(),
            "wall_s": wall,
            "wall_clock_s": round(wall_clock_s, 2),
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
        if args.child:
            # Intermediate artifact the parent merges; not part of the
            # documented report schema.
            report["runs_diffs"] = runs_diffs
        report["chat_failovers"] = chat_failovers or 0
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, ensure_ascii=False)
        print(f"[report] wrote {args.report}")
    return 0


def _run_db_path(db: str, r: int) -> str:
    """Per-run DB path (sibling of --db); covered by .gitignore's
    benchmark/*.db for the default location."""
    root, ext = os.path.splitext(db)
    return f"{root}_r{r}{ext or '.db'}"


def _child_command(args, run_db: str, child_report: str) -> list[str]:
    py = VENV_PY if os.path.exists(VENV_PY) else sys.executable
    cmd = [
        py, os.path.abspath(__file__),
        "--child",
        "--runs", "1",
        "--db", run_db,
        "--pristine", args.pristine,
        "--text-threshold", str(args.text_threshold),
        "--stage-concurrency", str(args.stage_concurrency),
        "--report", child_report,
    ]
    if args.cases:
        cmd += ["--cases", args.cases]
    return cmd


def _run_child(args, cases) -> int:
    """One cold run against the pristine snapshot passed by the parent.

    No seeding, no pristine rebuild, no full-corpus pinning — all parent-only
    steps. Restores the snapshot into --db and runs exactly one pass.
    """
    restore_snapshot(args.pristine, args.db)
    res, m, wall = run_once(cases, args.text_threshold, args.stage_concurrency)
    runs_diffs = {name: item["runs_diffs"] for name, item in res.items()}
    return _finalize(args, cases, runs_diffs, m, wall, wall)


def _run_inprocess(args, cases, pristine: str) -> int:
    """Sequential runs in this process (the pre-parallel behavior; also the
    --jobs 1 path)."""
    from benchmark.metrics import BenchmarkMetrics

    results: dict[str, dict] = {}
    totals_runs_metrics = []
    total_wall = 0.0
    clock_start = time.perf_counter()
    for _r in range(1, args.runs + 1):
        restore_snapshot(pristine, args.db)
        res, m, wall = run_once(cases, args.text_threshold, args.stage_concurrency)
        total_wall += wall
        totals_runs_metrics.append(m)
        for name, item in res.items():
            entry = results.setdefault(name, {"input": item["input"], "runs_diffs": []})
            entry["runs_diffs"].append(item["runs_diffs"][0])

    runs_diffs = {name: entry["runs_diffs"] for name, entry in results.items()}
    tot = BenchmarkMetrics()
    for m in totals_runs_metrics:
        tot.merge(m)
    return _finalize(args, cases, runs_diffs, tot, total_wall,
                     time.perf_counter() - clock_start)


def _merge_child_reports(reports: list[dict]) -> tuple[dict[str, list], "BenchmarkMetrics", float, int]:
    """Merge child reports (in run order, so per_run arrays stay ordered):
    per-case runs_diffs lists concatenated, metrics summed, ``wall_s`` summed
    (its documented semantic — sum of run walls — must survive merging),
    failover events summed."""
    from benchmark.metrics import BenchmarkMetrics

    runs_diffs: dict[str, list] = {}
    tot = BenchmarkMetrics()
    total_wall = 0.0
    total_failovers = 0
    for rep in reports:
        for name, runs in rep["runs_diffs"].items():
            runs_diffs.setdefault(name, []).extend(runs)
        tot.merge(BenchmarkMetrics.from_dict(rep["metrics"]))
        total_wall += rep["wall_s"]
        total_failovers += int(rep.get("chat_failovers") or 0)
    return runs_diffs, tot, total_wall, total_failovers


def _run_parallel(args, cases, pristine: str) -> int:
    """Spawn one child process per run — each restores its own DB copy from
    the same pristine snapshot, so runs stay perfectly isolated — at most
    --jobs at a time.

    Fail-fast: the first child that exits non-zero TERMINATES its still-
    running siblings (our own Popen handles only — never any shared dev
    server) and the parent propagates the child's exit code. Children's
    stdout is captured; the console contract (per-case lines + METRICS
    block) belongs to the parent.
    """
    child_reports: list[tuple[int, str]] = []
    procs: dict[int, subprocess.Popen] = {}
    clock_start = time.perf_counter()
    try:
        for wave_start in range(0, args.runs, args.jobs):
            batch = range(wave_start + 1, min(wave_start + args.jobs, args.runs) + 1)
            procs = {}
            for r in batch:
                run_db = _run_db_path(args.db, r)
                if args.report:
                    child_report = f"{args.report}.child{r}"
                else:
                    child_report = os.path.join(
                        tempfile.gettempdir(), f"bm_child_{os.getpid()}_{r}.json")
                child_reports.append((r, child_report))
                env = dict(os.environ)
                env["DATABASE_URL"] = f"sqlite:///{os.path.abspath(run_db)}"
                env["PYTHONUNBUFFERED"] = "1"
                procs[r] = subprocess.Popen(
                    _child_command(args, run_db, child_report),
                    cwd=BACKEND, env=env,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )

            failed = None
            while any(p.poll() is None for p in procs.values()):
                bad = [r for r, p in procs.items()
                       if p.poll() is not None and p.returncode != 0]
                if bad and failed is None:
                    failed = bad[0]
                    for p in procs.values():
                        if p.poll() is None:
                            p.terminate()
                    break
                time.sleep(0.2)

            outputs = {r: p.communicate() for r, p in procs.items()}
            failed = failed or next(
                (r for r, p in procs.items() if p.returncode != 0), None)
            if failed is not None:
                _out, err = outputs[failed]
                print(
                    f"[jobs] child run {failed} exited {procs[failed].returncode} "
                    "— failing fast",
                    file=sys.stderr,
                )
                if err:
                    print(err, file=sys.stderr)
                return procs[failed].returncode or 1
    finally:
        for p in procs.values():
            if p.poll() is None:
                p.terminate()
                p.wait()

    reports = []
    for _r, report_path in child_reports:
        with open(report_path, encoding="utf-8") as fh:
            reports.append(json.load(fh))
    for _r, report_path in child_reports:
        with contextlib.suppress(OSError):
            os.remove(report_path)

    runs_diffs, tot, total_wall, total_failovers = _merge_child_reports(reports)
    return _finalize(args, cases, runs_diffs, tot, total_wall,
                     time.perf_counter() - clock_start, total_failovers)


def main(argv=None) -> int:
    args = parse_args(argv)

    # Matcher/LLM errors are otherwise SILENT here (match_and_convert catches
    # everything; logging is unconfigured) — a degraded run would look like a
    # legitimate bad metric. Surface ERROR+ (matcher fallbacks, parse
    # failures) on stderr so pollution is attributable in the log.
    logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")

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

    if args.child:
        return _run_child(args, cases)

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

    print(
        f"[run] {args.runs} run(s) x {len(cases)} case(s) "
        f"(jobs={args.jobs}, stage_concurrency={args.stage_concurrency}); "
        f"threshold={args.text_threshold}; corpus={CORPUS_DIR}"
    )
    if args.jobs > 1 and args.runs > 1:
        return _run_parallel(args, cases, pristine)
    return _run_inprocess(args, cases, pristine)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BenchmarkBroken as e:
        print(f"BROKEN: {e}", file=sys.stderr)
        sys.exit(2)
