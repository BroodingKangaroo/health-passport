#!/usr/bin/env python3
"""Extraction benchmark — THE loop verify command (ISSUES.md #24).

Runs the LIVE pipeline (OCR -> LLM extraction -> matcher) over the local
corpus (`benchmark/corpus/<case>/`, one source document + `standardized.json`
golden per case, same JSON format as the e2e goldens), N times per case,
against a cold snapshot DB, and prints machine-readable metrics:

    METRIC recognition=0.94
    METRIC stability=0.88
    METRIC primary=0.83
    METRIC doc_fidelity=0.91
    METRIC extras_stable=0
    METRIC runs=3
    METRIC llm_calls=9
    METRIC input_tokens=18430
    METRIC output_tokens=5210
    METRIC ocr_bytes=2415013
    METRIC wall_s=92.4
    METRIC wall_clock_s=31.2
    METRIC fallback_extractions=0
    METRIC provider_error_calls=0
    METRIC chat_failovers=0
    METRIC stage_ocr_s=8.1
    METRIC stage_extract_s=11.3
    METRIC stage_match_s=30.0

``wall_s`` stays the SUM of run walls (provider latency; the cost guard's
input); ``wall_clock_s`` is the invocation's wall-clock (smaller when runs
execute in parallel). ``doc_fidelity`` scores the top-level document fields
outside the recognition universe (ISSUES.md F7); ``extras_stable`` counts
UNEXPECTED biomarker names seen in every run. ``fallback_extractions`` /
``provider_error_calls`` / ``chat_failovers`` are the pollution counters —
any count > 0 marks the run environment-suspect for the loop (SKILL.md),
never keep/discard material.

Metric version 2 (ISSUES.md F7): primary semantics are unchanged from v1;
doc_fidelity/extras_stable/runs are co-metrics. Reports carry a reproducibility
fingerprint (git HEAD, provider/model knobs, corpus hashes — F8) and
``benchmark/compare_reports.py`` turns two reports into a mechanical
KEEP/DISCARD/BROKEN/POLLUTED decision (F9).``--screen`` formalizes the cheap
single-run probe.

Parallelism: with ``--jobs > 1`` each run executes in its own subprocess
with a DB copy restored from the shared pristine snapshot (runs are
perfectly isolated; results are identical to sequential execution). Within
a run, ``--stage-concurrency`` fans the DB-free stages (OCR + LLM
extraction) out across cases; the matcher stays strictly sequential in
sorted case order so definition-creation ordering keeps its documented
semantics.

Isolation rules (mirrors validate_offline.py / e2e safety conventions):

- Pure library runner: NO server, NO port, NO HTTP.
- Own DBs driven through DATABASE_URL BEFORE app imports: the pinned seed
  (`--seed-db`), the live work DB (`--db`), and per-run copies. Never touches
  health_passport.db.
- Its own Mistral client (production retry/timeout config), fresh per run,
  wrapped in benchmark.metrics.InstrumentedMistral for cost accounting.
- REAL Mistral spend on every invocation: ~len(cases) x N x (OCR + 1-9 LLM
  calls). See README.md for cost notes.

DB lifecycle ("cold snapshot per run"):

1. The pinned SEED DB (`--seed-db`, default benchmark_seed.db) is seeded via
   `python -m app.db.seed_loinc` when missing or when its input fingerprint
   changed (F10; `--fresh-db` overrides). It is never mutated afterwards.
2. The live `--db` (benchmark_run.db) is RESET from the seed before every
   invocation, so definitions created by a previous run can never leak into
   the next world (the F10 false-baseline class).
3. A deterministic warm-up pass replays the WARMUP_CASES goldens through the
   matcher with client=None on the fresh live DB, anchoring the canonical
   `copies/mL` (linear) units and cross-lab local defs in the documented
   order.
4. That seeded+warm state is snapshotted (pristine file). Each of the N runs
   restores the snapshot first, so every run starts identically COLD —
   stability measures pure OCR/LLM nondeterminism, never def-warm-up state.

Exit codes: 0 = metrics computed (even when worse than baseline — the LOOP
decides keep/discard by comparing primary), 2 = hard failure (MISTRAL_API_KEY
missing, auth/quota errors, non-zero unclassified diffs unless
--allow-unclassified), 1 = unexpected crash (traceback). This keeps the loop's
"worse" vs "broken" distinction from ISSUES.md #24 intact.

Corpus governance (ISSUES.md F6): `--manifest` writes/refreshes
`corpus/manifest.json` (hashes + provenance + tuning|validation split), and
normal runs verify its hashes when present; `--split` selects a hold-out
partition. DB lifecycle (F10): the seed/pristine snapshot is fingerprinted over
the corpus goldens and matcher/extractor/seed inputs and is rebuilt
automatically whenever that fingerprint changes.
"""

import argparse
import contextlib
import glob
import hashlib
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
# Script-dir imports won't resolve `app.*` / `e2e.*` / `benchmark.*` namespace
# packages when invoked as `venv/bin/python benchmark/run_benchmark.py`;
# backend root must be importable before any lazy app import runs.
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from benchmark.report_schema import METRIC_VERSION  # noqa: E402

CORPUS_DIR = os.path.join(HERE, "corpus")
E2E_INPUTS = os.path.join(BACKEND, "e2e", "inputs")
E2E_GOLDEN = os.path.join(BACKEND, "e2e", "golden")
VENV_PY = os.path.join(BACKEND, "venv", "bin", "python")
DEFAULT_DB = os.path.join(HERE, "benchmark_run.db")
DEFAULT_SEED_DB = os.path.join(HERE, "benchmark_seed.db")
PRISTINE_DB = os.path.join(HERE, "benchmark_pristine.db")
BENCHMARK_USER_ID = "default"
CORPUS_MANIFEST = os.path.join(CORPUS_DIR, "manifest.json")
# Inputs whose content determines the seed/pristine snapshot (ISSUES.md F10).
# Both groups are fingerprinted together; the CODE half is the loop's A/B
# variable (recorded, non-gating) and the DATA half must match for two reports
# to be comparable. A change in any of them invalidates the seed DB automatically.
SNAPSHOT_CODE_INPUTS = [
    os.path.join(BACKEND, "app", "services", "extractor.py"),
]
SNAPSHOT_CODE_GLOBS = [
    os.path.join(BACKEND, "app", "services", "matcher", "**", "*.py"),
]
SNAPSHOT_DATA_INPUTS = [
    os.path.join(BACKEND, "app", "db", "seed_loinc.py"),
    os.path.join(BACKEND, "app", "db", "import_ranges.py"),
    # The warm-up/pinning unit mapping lives here and changes pinned units.
    os.path.join(BACKEND, "e2e", "warmup_db.py"),
    os.path.join(BACKEND, "data", "Loinc.csv"),
    os.path.join(BACKEND, "data", "loinc_aliases.json"),
    os.path.join(BACKEND, "data", "loinc_name_overrides.json"),
    os.path.join(BACKEND, "data", "multilingual_synonyms.json"),
]
SNAPSHOT_DATA_GLOBS = [
    os.path.join(CORPUS_DIR, "*", "standardized.json"),
    # e2e goldens feed the offline guard's warm-up replay directly.
    os.path.join(E2E_GOLDEN, "*", "standardized.json"),
]
# A screen run must include at least one case the change does NOT target, so a
# broad regression shows up even on the cheap probe (ISSUES.md F9/F7).
DEFAULT_CONTROL_CASES = ["оак_26.05"]

# Ceiling for --stage-concurrency: each in-flight OCR/LLM call occupies one
# worker of the module-level watchdog pool in benchmark.metrics (size 8), so
# fan-out beyond that would silently serialize on pool acquire.
MAX_STAGE_CONCURRENCY = 8

# Warm-up anchor goldens: local defs unify first-seen (names/ids — the
# cross-lab unification, 2026-08-29), so the pristine snapshot must anchor
# the колонофлор locals in the SAME order the e2e suite runs them
# (alphabetical: _16_13.05 before _16_25.06) for goldens to agree across
# worlds. The pre-task-1 reason (lg-anchor ordering) is obsolete.
WARMUP_CASES = ["колонофлор_16_13.05", "колонофлор_16_25.06"]


class BenchmarkBroken(Exception):
    """Hard failure: cannot produce comparable metrics (auth/quota/config)."""


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="HealthPassport extraction benchmark (live pipeline)")
    ap.add_argument("--runs", type=int, default=None,
                    help="repeats per case (default 3; --screen forces 1)")
    ap.add_argument("--cases", help="comma-separated subset of case names")
    ap.add_argument("--db", default=DEFAULT_DB, help="live benchmark sqlite DB path (reset every run)")
    ap.add_argument("--seed-db", default=DEFAULT_SEED_DB,
                    help="pinned LOINC-seeded base DB (fingerprint-cached, F10)")
    ap.add_argument("--fresh-db", action="store_true", help="force reseed of the pinned seed DB")
    ap.add_argument("--text-threshold", type=float, default=0.9,
                    help="similarity cutoff passed to the comparator (default 0.9)")
    ap.add_argument("--report", help="write a JSON report to this path")
    ap.add_argument("--dump-observed", metavar="DIR",
                    help="write each case's observed JSON into DIR (requires --jobs 1; "
                         "diagnostics only, not part of the report)")
    ap.add_argument("--seed-corpus", action="store_true",
                    help="copy current e2e inputs/goldens into benchmark/corpus/ and exit")
    ap.add_argument("--manifest", action="store_true",
                    help="write/refresh corpus/manifest.json (hashes + provenance) and exit")
    ap.add_argument("--split", choices=("tuning", "validation"),
                    help="run only cases assigned to this manifest split (F6 held-out)")
    ap.add_argument("--allow-corpus-drift", action="store_true",
                    help="warn instead of failing when corpus files differ from manifest hashes")
    ap.add_argument("--screen", action="store_true",
                    help="cheap single-run probe (runs=1, requires --cases; a control "
                         "case is added automatically)")
    ap.add_argument("--allow-unclassified", action="store_true",
                    help="do not exit 2 when compare.py shapes reach scoring unclassified")
    ap.add_argument("--jobs", type=int, default=3,
                    help="runs executed in parallel as isolated subprocesses, each with "
                         "its own DB copy (default 3; 1 = in-process sequential)")
    ap.add_argument("--stage-concurrency", type=int, default=2,
                    help="concurrent OCR+extraction calls per run; the matcher stays "
                         f"sequential (default 2, max {MAX_STAGE_CONCURRENCY})")
    ap.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--pristine", default=PRISTINE_DB, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    if args.screen:
        if args.runs not in (None, 1):
            ap.error("--screen implies --runs 1 (stability is degenerate by design)")
        if not args.cases:
            ap.error("--screen requires --cases (targeted cases + at least one control)")
        args.runs = 1
    elif args.runs is None:
        args.runs = 3
    if args.runs < 1:
        ap.error("--runs must be >= 1")
    if args.jobs < 1:
        ap.error("--jobs must be >= 1")
    if args.dump_observed and args.jobs != 1:
        ap.error("--dump-observed requires --jobs 1 (parallel children are "
                 "isolated subprocesses)")
    if not 1 <= args.stage_concurrency <= MAX_STAGE_CONCURRENCY:
        ap.error(f"--stage-concurrency must be 1..{MAX_STAGE_CONCURRENCY} (watchdog pool size)")
    if args.child and (args.seed_corpus or args.fresh_db or args.manifest or args.split):
        ap.error("--seed-corpus/--fresh-db/--manifest/--split are parent-only flags")
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


_sha256_cache: dict[str, str] = {}


def _sha256_file(path: str) -> str:
    """Content hash, cached per process (Loinc.csv is ~80 MB)."""
    cached = _sha256_cache.get(path)
    if cached is not None:
        return cached
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    digest = h.hexdigest()
    _sha256_cache[path] = digest
    return digest


def _case_source_files(cdir: str) -> list[str]:
    return [
        f for f in sorted(os.listdir(cdir))
        if os.path.isfile(os.path.join(cdir, f)) and not f.startswith(".")
        and f != "standardized.json"
    ]


def _read_manifest() -> dict:
    if not os.path.isfile(CORPUS_MANIFEST):
        return {}
    with open(CORPUS_MANIFEST, encoding="utf-8") as fh:
        return json.load(fh)


def _corpus_dir_names() -> list[str]:
    if not os.path.isdir(CORPUS_DIR):
        return []
    return sorted(
        n for n in os.listdir(CORPUS_DIR)
        if os.path.isdir(os.path.join(CORPUS_DIR, n))
    )


def write_corpus_manifest() -> int:
    """Write/refresh corpus/manifest.json (ISSUES.md F6).

    Hashes of the source document + golden plus provenance (source, reviewer,
    date, tuning|validation split). Existing provenance fields are preserved;
    new cases land as ``split: unassigned`` and must be curated by a human
    (corpus growth is a human-reviewed activity — see SKILL.md).
    """
    if not os.path.isdir(CORPUS_DIR):
        print(f"No corpus at {CORPUS_DIR}; run --seed-corpus first.", file=sys.stderr)
        return 2
    existing = _read_manifest()
    old = existing.get("cases") or {}
    cases: dict[str, dict] = {}
    unassigned = []
    for name in _corpus_dir_names():
        cdir = os.path.join(CORPUS_DIR, name)
        files = _case_source_files(cdir)
        gpath = os.path.join(cdir, "standardized.json")
        if not files or not os.path.isfile(gpath):
            print(f"[manifest] WARN skipped malformed case {name!r}", file=sys.stderr)
            continue
        prev = old.get(name) or {}
        split = prev.get("split") or "unassigned"
        if split == "unassigned":
            unassigned.append(name)
        # Start from prev so curator metadata (expected metric range, extra
        # provenance keys) survives a refresh; hashes/filename are refreshed.
        entry = dict(prev)
        entry.update({
            "document": files[0],
            "document_sha256": _sha256_file(os.path.join(cdir, files[0])),
            "golden_sha256": _sha256_file(gpath),
            "source": prev.get("source") or "unknown",
            "reviewer": prev.get("reviewer") or "unknown",
            "date": prev.get("date") or time.strftime("%Y-%m-%d"),
            "split": split,
        })
        cases[name] = entry
    if not cases and old:
        # Documents are gitignored: on a fresh clone the tracked manifest is
        # the only file present. Never wipe recorded provenance with an empty
        # rewrite — restore the documents first.
        print(
            "[manifest] refusing to replace a non-empty manifest with an empty "
            "one (corpus documents are gitignored; restore them first)",
            file=sys.stderr,
        )
        return 2
    manifest = dict(existing)
    manifest["schema"] = 1
    manifest["cases"] = cases
    with open(CORPUS_MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(f"[manifest] wrote {len(cases)} case(s) -> {CORPUS_MANIFEST}")
    if unassigned:
        print(
            f"[manifest] {len(unassigned)} case(s) still split=unassigned "
            f"(assign tuning|validation in the file): {unassigned}",
            file=sys.stderr,
        )
    return 0


def _verify_case_hashes(name: str, doc_path: str, gpath: str,
                        entry: dict, allow_drift: bool) -> list[str]:
    drift = []
    if entry.get("document_sha256") and _sha256_file(doc_path) != entry["document_sha256"]:
        drift.append(f"{name}: document hash differs from manifest ({entry.get('document')})")
    if entry.get("golden_sha256") and _sha256_file(gpath) != entry["golden_sha256"]:
        drift.append(f"{name}: golden hash differs from manifest")
    if drift and not allow_drift:
        raise SystemExit(
            "Corpus drift detected (ISSUES.md F6):\n  " + "\n  ".join(drift)
            + "\nA hand-verified corpus change must be explicit: re-hash with "
              "`--manifest`, or pass --allow-corpus-drift for a one-off run."
        )
    return drift


def load_corpus(subset=None, split=None, allow_drift=False):
    """[(name, input_path, golden_dict)] sorted; missing/goldenless cases error.

    When ``corpus/manifest.json`` exists its hashes are verified (loud failure
    on drift, see --allow-corpus-drift) and a ``split`` filter keeps only the
    selected tuning|validation partition.
    """
    cases = []
    problems = []
    drift_warnings: list[str] = []
    if not os.path.isdir(CORPUS_DIR):
        raise SystemExit(
            f"Corpus {CORPUS_DIR} is empty. Run with --seed-corpus to start from the e2e cases."
        )
    wanted = set(subset or [])
    manifest = _read_manifest().get("cases") or {}
    for name in sorted(os.listdir(CORPUS_DIR)):
        cdir = os.path.join(CORPUS_DIR, name)
        if not os.path.isdir(cdir):
            continue
        if wanted and name not in wanted:
            continue
        entry = manifest.get(name)
        if split is not None:
            if entry is None:
                raise SystemExit(
                    f"--split {split!r} requires corpus/manifest.json entries; "
                    f"{name!r} is unmanifested — run --manifest after a review."
                )
            if entry.get("split") != split:
                continue
        files = _case_source_files(cdir)
        gpath = os.path.join(cdir, "standardized.json")
        if not files or not os.path.isfile(gpath):
            problems.append(name)
            continue
        if entry is not None:
            drift_warnings.extend(_verify_case_hashes(name, os.path.join(cdir, files[0]),
                                                      gpath, entry, allow_drift))
        with open(gpath, encoding="utf-8") as fh:
            golden = json.load(fh)
        cases.append((name, os.path.join(cdir, files[0]), golden))
    if split is not None and not cases:
        raise SystemExit(f"No corpus cases assigned to split {split!r}.")
    missing = wanted - {c[0] for c in cases}
    if missing:
        raise SystemExit(f"--cases not found in corpus: {sorted(missing)}")
    if drift_warnings:
        for w in drift_warnings:
            print(f"[corpus] WARN drift (--allow-corpus-drift): {w}", file=sys.stderr)
    if problems:
        # F6 governance: a lost document/golden must shrink the corpus LOUDLY,
        # never silently (a smaller corpus would still produce a clean report).
        raise SystemExit(
            "Malformed/incomplete corpus cases (missing document or golden): "
            f"{problems}. Restore or remove the directories explicitly."
        )
    if not cases:
        raise SystemExit("No runnable corpus cases.")
    return cases


def _combined_fingerprint(components: dict[str, str]) -> str:
    return hashlib.sha256(
        "\n".join(f"{rel}:{digest}" for rel, digest in sorted(components.items()))
        .encode("utf-8")
    ).hexdigest()


def snapshot_inputs_fingerprint() -> dict:
    """Content fingerprint over everything that determines the seeded DB.

    Covers corpus goldens + matcher package + extractor + seed inputs
    (ISSUES.md F10). Stored beside the DB; a mismatch means the live DB still
    carries definitions from an older world and MUST be re-seeded.

    Split into a code half (the loop's A/B variable: matcher/extractor) and a
    data half (seed inputs + goldens) so compare_reports can gate the data
    world while merely recording code drift.
    """
    def _components(inputs, globs):
        files = [p for p in inputs if os.path.isfile(p)]
        for pattern in globs:
            files.extend(glob.glob(pattern, recursive=True))
        return {
            os.path.relpath(path, BACKEND): _sha256_file(path)
            for path in sorted(set(files))
        }

    code = _components(SNAPSHOT_CODE_INPUTS, SNAPSHOT_CODE_GLOBS)
    data = _components(SNAPSHOT_DATA_INPUTS, SNAPSHOT_DATA_GLOBS)
    combined_components = {**code, **data}
    return {
        "schema": 1,
        "fingerprint": _combined_fingerprint(combined_components),
        "code_fingerprint": _combined_fingerprint(code),
        "data_fingerprint": _combined_fingerprint(data),
        "components": combined_components,
    }


def _fingerprint_path(db_path: str) -> str:
    return db_path + ".fingerprint.json"


def _read_fingerprint(db_path: str) -> Optional[dict]:
    path = _fingerprint_path(db_path)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def ensure_seeded_db(db_path: str, fresh: bool):
    """Guarantee a LOINC-seeded sqlite at db_path (seed drops & recreates).

    Used for the PINNED seed DB, which is never mutated afterwards. It
    auto-invalidates when the fingerprint over corpus goldens/matcher/
    extractor/seed-inputs changes or is missing (ISSUES.md F10) — the old
    memory-based "remember to pass --fresh-db" ritual produced a false 0.8307
    baseline. ``--fresh-db`` remains the explicit override.
    """
    current = snapshot_inputs_fingerprint()
    recorded = _read_fingerprint(db_path)
    if os.path.exists(db_path) and not fresh:
        if recorded and recorded.get("fingerprint") == current["fingerprint"]:
            return False
        reason = ("fingerprint missing" if recorded is None
                  else "snapshot inputs changed since the DB was seeded")
        print(f"[seed] {reason} — rebuilding {os.path.basename(db_path)}")
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
    with open(_fingerprint_path(db_path), "w", encoding="utf-8") as fh:
        json.dump({**current, "created": time.strftime("%Y-%m-%dT%H:%M:%S")}, fh, indent=2)
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
                            all_goldens: Optional[list[dict]] = None,
                            pristine_path: str = PRISTINE_DB) -> str:
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

    pristine = pristine_path
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


def reset_working_db(seed_db: str, db_path: str):
    """Reset the live DB from the pinned seed before an invocation.

    Without this, definitions committed by an earlier in-process run survive
    in benchmark_run.db and are copied into the next pristine snapshot even
    when the input fingerprint is unchanged — the F10 false-baseline class.
    """
    if os.path.abspath(seed_db) == os.path.abspath(db_path):
        return
    from app.db.session import engine

    engine.dispose()
    for suffix in ("", "-wal", "-shm"):
        p = db_path + suffix
        if os.path.exists(p):
            os.remove(p)
    shutil.copyfile(os.path.abspath(seed_db), os.path.abspath(db_path))


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
    from app.services.extractor import (
        LLMProcessingError,
        OCRProcessingError,
        llm_extract,
        ocr_document,
    )
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
        try:
            # raise_on_hard_error: chat auth/quota must surface as exit 2
            # (BenchmarkBroken) instead of the silent "unknown + Raw OCR text"
            # fallback record — ISSUES.md F11. Other provider errors keep the
            # fallback + pollution-counter behavior.
            raw = llm_extract(markdown, wrapped, raise_on_hard_error=True)
        except LLMProcessingError as err:
            if err.kind in ("auth", "quota"):
                raise BenchmarkBroken(f"{name}: chat {err.kind} — {err.message}") from err
            raise
        metrics.record_stage("extract_s", time.perf_counter() - t0)
        if _is_fallback_record(raw):
            metrics.add_fallback_extraction()
        return name, raw

    try:
        raws = _extract_all(cases, _ocr_and_extract, stage_concurrency)

        from benchmark.scoring import doc_fidelity_for_run
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
            doc_score, _doc_fields = doc_fidelity_for_run(golden, observed, threshold)
            result = results.setdefault(
                name, {"input": input_path, "runs_diffs": [], "runs_doc": [], "observed": []}
            )
            result["runs_diffs"].append(diffs)
            result["runs_doc"].append(doc_score)
            result["observed"].append(observed)
        return results, metrics, time.perf_counter() - wall_start
    finally:
        db.close()


def _git_state() -> tuple[Optional[str], Optional[bool]]:
    """(HEAD sha, dirty flag) for the report fingerprint; (None, None) when
    git is unavailable (tarball/CI checkout) — compare_reports treats missing
    values as a fingerprint mismatch, never as "equal"."""
    def _run(*cmd):
        return subprocess.run(cmd, cwd=BACKEND, capture_output=True, text=True, timeout=15)

    try:
        head = _run("git", "rev-parse", "HEAD")
        dirty = _run("git", "status", "--porcelain", "--untracked-files=no")
    except (OSError, subprocess.SubprocessError):
        return None, None
    if head.returncode != 0:
        return None, None
    return head.stdout.strip(), (bool(dirty.stdout.strip())
                                 if dirty.returncode == 0 else None)


def _hash_entries(entries: list[tuple[str, str]]) -> Optional[str]:
    if not entries:
        return None
    h = hashlib.sha256()
    for rel, digest in entries:
        h.update(f"{rel}:{digest}\n".encode())
    return h.hexdigest()


def _corpus_hashes() -> tuple[Optional[str], Optional[str]]:
    """Combined content hashes over the FULL corpus (documents + goldens)."""
    docs: list[tuple[str, str]] = []
    goldens: list[tuple[str, str]] = []
    for name in _corpus_dir_names():
        cdir = os.path.join(CORPUS_DIR, name)
        docs.extend(
            (f"{name}/{f}", _sha256_file(os.path.join(cdir, f)))
            for f in _case_source_files(cdir)
        )
        gpath = os.path.join(cdir, "standardized.json")
        if os.path.isfile(gpath):
            goldens.append((f"{name}/standardized.json", _sha256_file(gpath)))
    return _hash_entries(docs), _hash_entries(goldens)


def _effective_chat_provider() -> str:
    """Resolved provider, not the raw env: mirrors chat_client's gating
    (`CHAT_PROVIDER=openrouter` without OPENROUTER_API_KEY is still Mistral)."""
    has_openrouter = bool(os.getenv("OPENROUTER_API_KEY"))
    provider = os.getenv("CHAT_PROVIDER", "").lower()
    failover = os.getenv("CHAT_FAILOVER", "").lower() == "openrouter"
    if has_openrouter and provider == "openrouter":
        return "openrouter"
    if has_openrouter and failover:
        return "mistral+openrouter-failover"
    return "mistral"


def _report_config(args, cases) -> dict:
    """Reproducibility fingerprint + run shape written into every report
    (ISSUES.md F8). compare_reports.py refuses cross-fingerprint comparisons
    without --allow-env-drift."""
    git_head, git_dirty = _git_state()
    corpus_hash, golden_hash = _corpus_hashes()
    snapshot = snapshot_inputs_fingerprint()
    chat_model = None
    ocr_model = None
    with contextlib.suppress(Exception):
        from config import MISTRAL_CHAT_MODEL
        chat_model = MISTRAL_CHAT_MODEL
    with contextlib.suppress(Exception):
        from app.services.extractor import OCR_MODEL
        ocr_model = OCR_MODEL
    return {
        "metric_version": METRIC_VERSION,
        "mode": "screen" if args.screen else "full",
        "runs": args.runs,
        "jobs": args.jobs,
        "stage_concurrency": args.stage_concurrency,
        "text_threshold": args.text_threshold,
        "cases": [c[0] for c in cases],
        "db": args.db,
        "allow_unclassified": bool(args.allow_unclassified),
        "git_head": git_head,
        "git_dirty": git_dirty,
        "chat_provider": _effective_chat_provider(),
        "chat_model": chat_model,
        "openrouter_model": os.getenv("OPENROUTER_CHAT_MODEL"),
        "openrouter_scope": os.getenv("OPENROUTER_SCOPE"),
        "chat_failover": os.getenv("CHAT_FAILOVER"),
        "ocr_model": ocr_model,
        "ocr_markdown_clean": os.getenv("OCR_MARKDOWN_CLEAN", "1"),
        "corpus_hash": corpus_hash,
        "golden_hash": golden_hash,
        "snapshot_fingerprint": snapshot.get("fingerprint"),
        "snapshot_code_fingerprint": snapshot.get("code_fingerprint"),
        "snapshot_data_fingerprint": snapshot.get("data_fingerprint"),
    }


def _finalize(args, cases, runs_diffs: dict[str, list], tot_metrics, total_wall: float,
              wall_clock_s: float, chat_failovers: Optional[int] = None,
              runs_doc: Optional[dict[str, list[float]]] = None) -> int:
    """Score merged runs_diffs, print per-case lines + the METRICS block and
    write the report. Shared by the parent's in-process and parallel paths
    (and by --child, whose stdout the parent captures).

    ``wall_s`` keeps its documented semantic — the SUM of run walls (provider
    latency, scheduling-independent, the cost guard's input). ``wall_clock_s``
    is the additive human-facing wall-clock of the whole invocation.
    ``runs_doc`` carries the per-run doc_fidelity scores (ISSUES.md F7).
    """
    from benchmark.scoring import aggregate, case_scores

    inputs = {name: path for name, path, _g in cases}
    scores = {}
    doc_scores: dict[str, float] = {}
    unclassified_total = 0
    stable_extras_total = 0
    for name, runs in runs_diffs.items():
        golden = next((g for n, _p, g in cases if n == name), {})
        sc = case_scores(golden, runs)
        sc["input"] = inputs.get(name)
        if runs_doc and runs_doc.get(name):
            doc_runs = runs_doc[name]
            sc["doc_fidelity"] = sum(doc_runs) / len(doc_runs)
            doc_scores[name] = sc["doc_fidelity"]
        scores[name] = sc
        unclassified_total += len(sc["unclassified"])
        stable_extras_total += sc["extras_stable"]
        unstable = ", ".join(sc["unstable_items"]) or "-"
        doc_part = f" doc={sc['doc_fidelity']:.3f}" if "doc_fidelity" in sc else ""
        extras = sorted(sc["stable_extra_items"])
        extras_part = f" extras={sc['extras_total']} stable_extras={extras}" if extras \
            else f" extras={sc['extras_total']} stable_extras=0"
        print(
            f"[{name}] universe={sc['universe_size']} "
            f"per_run_rec={[round(v, 3) for v in sc['per_run_recognition']]} "
            f"recognition={sc['recognition']:.3f} stability={sc['stability']:.3f}"
            f"{extras_part} unstable={unstable}{doc_part}"
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
    agg["extras_stable"] = stable_extras_total
    if doc_scores:
        agg["doc_fidelity"] = round(sum(doc_scores.values()) / len(doc_scores), 4)

    wall = round(total_wall, 2)
    print("\n--- METRICS ---")
    print(f"METRIC recognition={agg['recognition']:.4f}")
    print(f"METRIC stability={agg['stability']:.4f}")
    print(f"METRIC primary={agg['primary']:.4f}")
    print(f"METRIC doc_fidelity={agg.get('doc_fidelity', 0.0):.4f}")
    print(f"METRIC extras_stable={agg['extras_stable']}")
    print(f"METRIC runs={args.runs}")
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
    if args.runs < 3 and not args.child:
        print(
            "[warn] runs < 3: stability is degenerate; screens are not keep-material "
            "(full --runs 3 verify required)",
            file=sys.stderr,
        )
    for k, v in tot_metrics.stage_seconds.items():
        print(f"METRIC stage_{k}={round(v, 2)}")

    if args.report:
        report = {
            "config": _report_config(args, cases),
            "aggregate": agg,
            "metrics": tot_metrics.to_dict(),
            "wall_s": wall,
            "wall_clock_s": round(wall_clock_s, 2),
            "unclassified_total": unclassified_total,
            "cases": {
                name: {
                    "input": sc["input"],
                    "universe_size": sc["universe_size"],
                    "recognition": round(sc["recognition"], 4),
                    "stability": round(sc["stability"], 4),
                    "extras_total": sc["extras_total"],
                    "extras_stable": sc["extras_stable"],
                    "stable_extra_items": sc["stable_extra_items"],
                    "doc_fidelity": (round(sc["doc_fidelity"], 4)
                                     if "doc_fidelity" in sc else None),
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
            if runs_doc:
                report["runs_doc"] = runs_doc
        report["chat_failovers"] = chat_failovers or 0
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, ensure_ascii=False)
        print(f"[report] wrote {args.report}")

    if unclassified_total and not args.allow_unclassified and not args.child:
        print(
            f"BROKEN: {unclassified_total} unclassified diff(s) — the scoring parser "
            "cannot attribute them to an item (pass --allow-unclassified to override)",
            file=sys.stderr,
        )
        return 2
    return 0


def _run_db_path(db: str, r: int) -> str:
    """Per-run DB path (sibling of --db); covered by .gitignore's
    benchmark/*.db for the default location."""
    root, ext = os.path.splitext(db)
    return f"{root}_r{r}{ext or '.db'}"


def _child_command(args, run_db: str, child_report: str,
                   pristine: Optional[str] = None,
                   case_names: Optional[list[str]] = None) -> list[str]:
    """Child argv. `case_names` MUST be the parent's resolved case list (after
    --split/--screen control injection) — otherwise a split-filtered parent
    would silently spawn whole-corpus children."""
    py = VENV_PY if os.path.exists(VENV_PY) else sys.executable
    names = case_names if case_names is not None else (
        [c.strip() for c in args.cases.split(",")] if args.cases else []
    )
    cmd = [
        py, os.path.abspath(__file__),
        "--child",
        "--runs", "1",
        "--db", run_db,
        "--pristine", pristine or args.pristine,
        "--text-threshold", str(args.text_threshold),
        "--stage-concurrency", str(args.stage_concurrency),
        "--report", child_report,
        "--cases", ",".join(names),
    ]
    if getattr(args, "allow_corpus_drift", False):
        cmd.append("--allow-corpus-drift")
    return cmd


def _run_child(args, cases) -> int:
    """One cold run against the pristine snapshot passed by the parent.

    No seeding, no pristine rebuild, no full-corpus pinning — all parent-only
    steps. Restores the snapshot into --db and runs exactly one pass.
    """
    restore_snapshot(args.pristine, args.db)
    res, m, wall = run_once(cases, args.text_threshold, args.stage_concurrency)
    runs_diffs = {name: item["runs_diffs"] for name, item in res.items()}
    runs_doc = {name: item["runs_doc"] for name, item in res.items()}
    return _finalize(args, cases, runs_diffs, m, wall, wall, runs_doc=runs_doc)


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
            entry = results.setdefault(
                name, {"input": item["input"], "runs_diffs": [], "runs_doc": []}
            )
            entry["runs_diffs"].append(item["runs_diffs"][0])
            entry["runs_doc"].append(item["runs_doc"][0])
            entry.setdefault("observed", []).append(item["observed"][0])

    if args.dump_observed:
        os.makedirs(args.dump_observed, exist_ok=True)
        for name, entry in results.items():
            for i, obs in enumerate(entry.get("observed", []), start=1):
                dest = os.path.join(args.dump_observed, f"{name}.run{i}.json")
                with open(dest, "w", encoding="utf-8") as fh:
                    json.dump(obs, fh, indent=2, ensure_ascii=False)
        print(f"[dump] observed JSON -> {args.dump_observed}")

    runs_diffs = {name: entry["runs_diffs"] for name, entry in results.items()}
    runs_doc = {name: entry["runs_doc"] for name, entry in results.items()}
    tot = BenchmarkMetrics()
    for m in totals_runs_metrics:
        tot.merge(m)
    return _finalize(args, cases, runs_diffs, tot, total_wall,
                     time.perf_counter() - clock_start, runs_doc=runs_doc)


def _merge_child_reports(reports: list[dict]) -> tuple[dict[str, list], dict[str, list],
                                                       "BenchmarkMetrics", float, int]:
    """Merge child reports (in run order, so per_run arrays stay ordered):
    per-case runs_diffs/runs_doc lists concatenated, metrics summed,
    ``wall_s`` summed (its documented semantic — sum of run walls — must
    survive merging), failover events summed."""
    from benchmark.metrics import BenchmarkMetrics

    runs_diffs: dict[str, list] = {}
    runs_doc: dict[str, list] = {}
    tot = BenchmarkMetrics()
    total_wall = 0.0
    total_failovers = 0
    for rep in reports:
        for name, runs in rep["runs_diffs"].items():
            runs_diffs.setdefault(name, []).extend(runs)
        for name, docs in (rep.get("runs_doc") or {}).items():
            runs_doc.setdefault(name, []).extend(docs)
        tot.merge(BenchmarkMetrics.from_dict(rep["metrics"]))
        total_wall += rep["wall_s"]
        total_failovers += int(rep.get("chat_failovers") or 0)
    return runs_diffs, runs_doc, tot, total_wall, total_failovers


def _remove_artifact(path: str):
    for suffix in ("", "-wal", "-shm"):
        with contextlib.suppress(OSError):
            os.remove(path + suffix)


def _run_parallel(args, cases, pristine: str) -> int:
    """Spawn one child process per run — each restores its own DB copy from
    the same pristine snapshot, so runs stay perfectly isolated — at most
    --jobs at a time.

    Fail-fast: the first child that exits non-zero TERMINATES its still-
    running siblings (our own Popen handles only — never any shared dev
    server) and the parent propagates the child's exit code. Children's
    stdout/stderr go to temp files, never PIPE (an unread pipe could
    backpressure a chatty child into a latent deadlock — ISSUES.md F12);
    the console contract (per-case lines + METRICS block) belongs to the
    parent.

    Artifact hygiene (F12): child reports, per-run DBs and temp logs are
    removed on both the success and fail-fast paths. A hard SIGKILL of the
    parent leaves those as residue on purpose — nothing else cleans them.
    """
    child_reports: list[tuple[int, str]] = []
    log_paths: list[str] = []
    err_paths: dict[int, str] = {}
    run_db_paths: list[str] = []
    procs: dict[int, subprocess.Popen] = {}
    cleanup_on_exit = False
    case_names = [c[0] for c in cases]
    clock_start = time.perf_counter()

    def _fail_cleanup():
        for _r, report_path in child_reports:
            _remove_artifact(report_path)
        for run_db in run_db_paths:
            _remove_artifact(run_db)
        for path in log_paths:
            _remove_artifact(path)

    try:
        for wave_start in range(0, args.runs, args.jobs):
            batch = range(wave_start + 1, min(wave_start + args.jobs, args.runs) + 1)
            procs = {}
            for r in batch:
                run_db = _run_db_path(args.db, r)
                run_db_paths.append(run_db)
                if args.report:
                    child_report = f"{args.report}.child{r}"
                else:
                    child_report = os.path.join(
                        tempfile.gettempdir(), f"bm_child_{os.getpid()}_{r}.json")
                child_reports.append((r, child_report))
                out_path = os.path.join(
                    tempfile.gettempdir(), f"bm_child_{os.getpid()}_{r}.out")
                err_path = os.path.join(
                    tempfile.gettempdir(), f"bm_child_{os.getpid()}_{r}.err")
                err_paths[r] = err_path
                log_paths.extend([out_path, err_path])
                env = dict(os.environ)
                env["DATABASE_URL"] = f"sqlite:///{os.path.abspath(run_db)}"
                env["PYTHONUNBUFFERED"] = "1"
                with open(out_path, "w", encoding="utf-8") as out_fh, \
                        open(err_path, "w", encoding="utf-8") as err_fh:
                    procs[r] = subprocess.Popen(
                        _child_command(args, run_db, child_report, pristine, case_names),
                        cwd=BACKEND, env=env,
                        stdout=out_fh, stderr=err_fh, text=True,
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

            failed = failed or next(
                (r for r, p in procs.items() if p.returncode != 0), None)
            if failed is not None:
                print(
                    f"[jobs] child run {failed} exited {procs[failed].returncode} "
                    "— failing fast",
                    file=sys.stderr,
                )
                with contextlib.suppress(OSError), \
                        open(err_paths[failed], encoding="utf-8") as fh:
                    err = fh.read()
                    if err:
                        print(err, file=sys.stderr)
                cleanup_on_exit = True
                return procs[failed].returncode or 1
    finally:
        # Reap/terminate OUR children first, then remove their artifacts:
        # deleting a run DB while a sibling still holds it open is racy.
        for p in procs.values():
            if p.poll() is None:
                p.terminate()
                p.wait()
        if cleanup_on_exit:
            _fail_cleanup()

    reports = []
    for _r, report_path in child_reports:
        with open(report_path, encoding="utf-8") as fh:
            reports.append(json.load(fh))
    for _r, report_path in child_reports:
        _remove_artifact(report_path)
    for path in log_paths:
        _remove_artifact(path)
    for run_db in run_db_paths:
        _remove_artifact(run_db)

    runs_diffs, runs_doc, tot, total_wall, total_failovers = _merge_child_reports(reports)
    return _finalize(args, cases, runs_diffs, tot, total_wall,
                     time.perf_counter() - clock_start, total_failovers,
                     runs_doc=runs_doc)


def main(argv=None) -> int:
    args = parse_args(argv)

    # Matcher/LLM errors are otherwise SILENT here (match_and_convert catches
    # everything; logging is unconfigured) — a degraded run would look like a
    # legitimate bad metric. Surface ERROR+ (matcher fallbacks, parse
    # failures) on stderr so pollution is attributable in the log.
    logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")

    if args.seed_corpus:
        return seed_corpus_from_e2e()
    if args.manifest:
        return write_corpus_manifest()

    from dotenv import load_dotenv

    load_dotenv(os.path.join(BACKEND, ".env"))
    os.environ["DATABASE_URL"] = f"sqlite:///{os.path.abspath(args.db)}"

    if not os.environ.get("MISTRAL_API_KEY"):
        print("BROKEN: MISTRAL_API_KEY is not configured (backend/.env)", file=sys.stderr)
        return 2

    subset = [c.strip() for c in args.cases.split(",")] if args.cases else None
    if args.screen and subset is not None:
        # A screen must include a case the change does NOT target; otherwise a
        # broad regression is invisible on the cheap probe (ISSUES.md F9).
        # Resolve controls under the same --split so a control outside the
        # split can never be injected and then rejected as "not found".
        known = {n for n, _p, _g in load_corpus(
            None, split=args.split, allow_drift=args.allow_corpus_drift)}
        added = []
        for control in DEFAULT_CONTROL_CASES:
            if control in known and control not in subset:
                subset.append(control)
                added.append(control)
        if added:
            print(f"[screen] added control case(s): {added}")
        else:
            print(
                "[screen] WARN no control case available (corpus lacks "
                f"{DEFAULT_CONTROL_CASES} or it is already targeted)",
                file=sys.stderr,
            )

    cases = load_corpus(subset, split=args.split, allow_drift=args.allow_corpus_drift)

    if args.child:
        return _run_child(args, cases)

    # Pinned seed -> fresh live DB every invocation (no run residue may leak
    # into the next world; ISSUES.md F10).
    ensure_seeded_db(args.seed_db, args.fresh_db)
    reset_working_db(args.seed_db, args.db)

    # Warm-up anchor goldens (cross-lab local unification order — see
    # WARMUP_CASES above).
    warmup = []
    wanted = {name: golden for name, _path, golden in cases}
    for name in WARMUP_CASES:
        golden = wanted.get(name)
        if golden is not None:
            warmup.append(golden)
    if not warmup and not args.cases:
        print(
            f"[warn] corpus lacks the {WARMUP_CASES} warm-up cases — "
            "local-def anchor ordering caveat (see e2e/KNOWN_ISSUES.md) is unhandled",
            file=sys.stderr,
        )

    # Pin from the FULL corpus goldens even on --cases subsets: a subset
    # probe must restore the same snapshot warmth a full run would have.
    _all_corpus = load_corpus(None, allow_drift=args.allow_corpus_drift)
    pristine = build_pristine_snapshot(
        args.db, warmup, all_goldens=[g for _n, _p, g in _all_corpus],
        pristine_path=args.pristine,
    )

    mode = "screen" if args.screen else (f"split:{args.split}" if args.split else "full")
    print(
        f"[run] {mode}: {args.runs} run(s) x {len(cases)} case(s) "
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
