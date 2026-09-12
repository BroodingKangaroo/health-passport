# Extraction benchmark (autoresearch loop verify command)

A standalone quality/cost benchmark for the **live** extraction pipeline
(OCR → LLM extraction → matcher), driven by a project-local autoresearch loop.
See ISSUES.md #24 in git history for the original proposal.

## Safety & cost (read first)

- **Real Mistral spend on every invocation**: roughly `len(cases) × N ×
  (1 OCR + 1–9 LLM calls)` with tens-of-K prompt tokens on large documents.
  `--runs` defaults to 3 — probe with `--runs 1 --cases <name>` first.
- **Pure library runner**: no server, no port, no HTTP. Never boots uvicorn,
  never touches port 8000 (the same no-pkill/no-port-8000 rules as `e2e/`).
- Own DBs (`benchmark_seed.db` pinned + `benchmark_run.db` live + pristine
  snapshot copies); never touches `health_passport.db`. `seed_loinc` inside
  this flow drops/recreates ONLY the benchmark seed DB.
- Off-limits to the loop that consumes these metrics: `app/db/seed_loinc*`,
  `data/Loinc.csv`, e2e goldens, goldens in `corpus/`, all DB files.

## Layout

```
backend/benchmark/
  corpus/<case>/            # source document(s) + standardized.json golden
                            #   (same JSON format as backend/e2e/goldens)
  corpus/manifest.json      # tracked: hashes + provenance + tuning|validation
                            #   split (F6); documents themselves stay gitignored
  metrics.py                # instrumented Mistral wrapper: calls/tokens/bytes/stages
  scoring.py                # diff-grouping → recognition / stability / doc_fidelity
  report_schema.py          # metric version + fingerprint fields + verdict codes
  run_benchmark.py          # THE verify command (also --manifest/--split/--screen)
  compare_reports.py        # mechanical KEEP|DISCARD|BROKEN|POLLUTED verdict (F9)
  benchmark_seed.db         # pinned LOINC-seeded base DB (gitignored artifact)
  benchmark_seed.db.fingerprint.json # seed-input fingerprint (F10, gitignored)
  benchmark_run.db          # live working DB, reset from the seed each run
  benchmark_pristine.db     # per-invocation snapshot template (gitignored)
  reports/                  # optional --report JSON output dir (gitignored)
backend/e2e/validate_offline.db      # guard work DB, rebuilt every run (F13)
backend/e2e/validate_offline_seed.db # guard pinned seed DB (F13)
```

## Seeding the corpus

The corpus is a **local artifact** (gitignored, so the same medical documents
aren't duplicated in git twice). The initial copy comes from the current e2e
cases:

```bash
venv/bin/python benchmark/run_benchmark.py --seed-corpus
```

Grow it by dropping more real documents plus hand-verified goldens into
`corpus/<case>/standardized.json` (verify them like any e2e golden before
scoring against them — custom additions beyond e2e live only on your machine,
so keep a private backup if you curate them).

### Corpus governance (ISSUES.md F6)

Corpus growth is a **human-reviewed activity**, never a loop iteration.

- `venv/bin/python benchmark/run_benchmark.py --manifest` writes/refreshes
  `corpus/manifest.json`: per-case document + golden sha256, `source`,
  `reviewer`, `date`, and `split: tuning|validation`. Existing provenance
  fields are preserved; a NEW case lands as `split: unassigned` until a human
  assigns it.
- Normal runs verify the manifest hashes and **hard-fail on drift** (a
  hand-verified file changed): re-hash explicitly with `--manifest`, or pass
  `--allow-corpus-drift` for a one-off (the parent forwards the override to
  parallel children). Untracked documents mean the manifest is the portable
  provenance record across machines.
- A malformed case (document or golden missing) is a hard error, never a
  silent skip: a shrunken corpus would still produce a clean-looking report.
  A `--manifest` refresh preserves curator metadata (unknown per-case keys
  included) and refuses to replace a non-empty manifest with an empty one
  (fresh clone: restore the gitignored documents first).
- `--split validation` runs only the held-out partition (~30%; never target
  it in screens). `--split tuning` runs the rest. A split request fails when
  the manifest has no such cases.
- New-case acceptance: `--runs 1 --cases <new>` clean (pollution counters 0),
  matcher-only deterministic on the guard DB, golden hand-verified via the
  `e2e-golden` workflow, and an expected metric range recorded.

## Running

```bash
cd backend
venv/bin/python benchmark/run_benchmark.py                 # N=3 over the whole corpus
venv/bin/python benchmark/run_benchmark.py --screen \
    --cases оак_26.05 --report reports/screen_01.json      # runs=1 probe + control
venv/bin/python benchmark/run_benchmark.py --report reports/iter_01.json
venv/bin/python benchmark/run_benchmark.py --split validation
venv/bin/python benchmark/compare_reports.py \
    reports/baseline_v6.json reports/iter_01.json          # KEEP|DISCARD|...
```

`--screen` is the formal cheap probe (F9): forces `--runs 1`, requires
`--cases` (the targeted set), appends a control case from
`DEFAULT_CONTROL_CASES` when available, and marks the report `mode=screen`.
Screen reports are never keep material — `compare_reports.py` caps a
promising screen at DISCARD with "run the full verify".

`compare_reports.py` applies the loop's keep rule mechanically (F9):
fingerprint/version/unclassified integrity → BROKEN, pollution counters →
POLLUTED, `Δprimary ≥ ε` on a full report → KEEP, everything else → DISCARD.
Exit codes: 0 KEEP, 1 DISCARD, 2 BROKEN, 3 POLLUTED. It refuses
cross-fingerprint comparisons unless `--allow-env-drift` (debugging only).

`--allow-unclassified` downgrades the hard failure on unclassified diffs to a
warning (reports still record `unclassified_total`; `compare_reports` treats
an unallowed unclassified report as BROKEN).

### Parallelism flags

- `--jobs N` (default 3): runs execute in parallel as isolated subprocesses,
  each restoring its own DB copy from the shared pristine snapshot
  (`benchmark_run_r<i>.db`, gitignored). Results are identical to sequential
  execution — same snapshot, same matcher ordering. `--jobs 1` runs
  in-process sequentially (debugging-friendly).
- `--stage-concurrency K` (default 2, max 8): within a run, the DB-free
  stages (OCR + LLM extraction) fan out across cases with a bounded thread
  pool. The matcher stays strictly sequential in sorted case order, so
  definition-creation ordering keeps its documented semantics. The cap is the
  instrumentation watchdog pool size (each in-flight call occupies one
  worker).
- Fail-fast: the first failing child terminates its running siblings (its own
  subprocesses only) and the parent propagates the child's exit code; within
  a run, a hard OCR failure cancels not-yet-started sibling work. No spend
  continues behind a doomed run. Child stdout/stderr are redirected to temp
  files (never PIPE) so a chatty child cannot backpressure into a deadlock;
  both the success and fail-fast paths remove this invocation's child reports,
  per-run DBs and temp logs (F12). A hard SIGKILL of the parent leaves those
  as residue — nothing else cleans them.

With defaults (`--jobs 3 --stage-concurrency 2`) a full 9-case × 3-runs
verify drops from ~66 min to roughly 15–25 min (it is ~99% Mistral latency;
the matcher — ~half the wall — remains sequential by design).

Output ends in a machine-readable block:

```
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
```

Exit codes: **0** metrics computed (even if worse than baseline — deciding
worse vs better is the *loop's* job reading `primary`), **2** hard failure
(`MISTRAL_API_KEY` missing, OCR **or chat** auth/quota, non-zero
`unclassified` diffs unless `--allow-unclassified`), **1** unexpected crash.

## Metric semantics

Each case runs N times (`--runs`, default 3) from an identically COLD DB
snapshot. Diffs come from `e2e/compare.py` (`compare_standardized`) at
`--text-threshold` (default 0.9) and are grouped back to items.

- **Golden universe** = comparable items in the golden JSON: one item per
  unique biomarker `raw_name`, non-empty visit field, prescription/
  recommendation index, non-empty instrumental field. Top-level fields
  (`entry_type/date/time/clinic/provider/title/notes`) are OUTSIDE the
  universe — their diffs print as warnings but don't move recognition.
- **recognition** (per run) = `(recognized_items − 0.5 × extras) /
  universe_size` clamped to [0,1]. Extras are UNEXPECTED biomarkers plus
  excess rows implied by prescription/recommendation count mismatches.
  Averaged over runs then cases.
- **stability** (per case) = fraction of universe items recognized in ALL N
  runs (intersection). Averaged over cases.
- **primary** = `recognition × stability` — the loop's keep/discard scalar
  (semantics unchanged since metric v1).
- **doc_fidelity** (metric v2, F7) = mean over runs then cases of the fraction
  of golden-populated top-level fields (`entry_type/date/time/clinic/provider/
  title/notes`) the run carried faithfully. Unlike recognition, an omitted
  observed value is a MISS (that is exactly the documented time-drop this
  co-metric exists to expose); free-text fields use comparator similarity +
  `*_alt`. It is a co-metric, NOT part of `primary`.
- **extras_stable** (metric v2, F7) = total number of UNEXPECTED biomarker
  names seen in EVERY run of their case (`stable_extra_items` in the report),
  so a consistently hallucinated row is visible in both axes.
- **cost co-metrics**: `llm_calls`, `input_tokens` (SDK `usage.prompt_tokens`),
  `output_tokens` (`usage.completion_tokens`), `ocr_bytes` (Files upload size;
  OCR `usage_info.doc_size_bytes` fallback), `wall_s` (**sum of run walls** —
  provider latency, scheduling-independent; the loop's cost-regression guard
  reads this one), `wall_clock_s` (invocation wall-clock; smaller than
  `wall_s` when runs execute in parallel), `stage_ocr_s` / `stage_extract_s`
  / `stage_match_s` (cumulative per-stage seconds).
- **pollution counters** (loop keep-rule guard, SKILL.md):
  `fallback_extractions` counts extractions that ended in the silent
  "unknown + Raw OCR text" failure record; `provider_error_calls` counts
  calls that raised at the instrumentation boundary AFTER the SDK's own
  retry/backoff gave up (5xx storms, timeouts, watchdog kills);
  `chat_failovers` counts Mistral→OpenRouter failovers. ANY count > 0 marks
  the run environment-suspect: the loop re-runs once (bounded) and never
  keeps/discards on polluted data. Chat auth/quota is different: it is
  classified (`LLMProcessingError.kind`, F11) and exits 2 as BROKEN rather
  than degrading into the fallback record.

### Golden format: provider/OCR variance

Goldens are provider-neutral. Two LLMs translate the same Russian source
differently and both can be valid, and OCR keeps/strips list numbering
nondeterministically — neither may read as a quality failure:

- `translated_en_alt` (optional, per TranslatedText entry): alternative
  acceptable EN renderings. The comparator scores against the BEST of
  primary + alternatives (`e2e/compare.py::_cmp_tx`).
- Leading list markers ("1. ", "2) ", "• ") are stripped from both sides
  before comparison — ordering is already encoded in the item index.

A golden update must remain hand-verified truth: only add renderings that a
reviewer judged equivalent to the source text (e.g. «Рациональное питание» →
"Rational nutrition" is the literal reading of the golden's "Balanced
nutrition"; the телефон in гастро rec[2] is printed WITHOUT the +375
country code — GLM's verbatim copy is more faithful than the golden's own
embellishment).

### Seed-DB fingerprint (F10)

`benchmark_seed.db` is the pinned, never-mutated LOINC seed; the live
`benchmark_run.db` is reset from it at the start of every invocation, so
definitions committed by a previous run can never leak into the next world.
The seed is validated against a content fingerprint over the corpus goldens +
e2e goldens + `app/services/matcher/**` + `app/services/extractor.py` +
`e2e/warmup_db.py` (its unit map feeds the golden pinning) + the seed inputs
(`seed_loinc.py`, `import_ranges.py`, `data/Loinc.csv` and the JSON
alias/synonym files). The fingerprint is stored beside the seed
(`*.fingerprint.json`). A missing or changed fingerprint triggers an automatic
LOINC reseed before the run — the old "remember to pass `--fresh-db` after an
anchoring/golden change" ritual silently produced a false 0.8307 baseline and
is gone. `--fresh-db` remains the explicit override; `--seed-db` relocates the
pinned seed.

### Report fingerprint (F8)

Every `--report` carries `config.metric_version` and a reproducibility
fingerprint: `git_head`/`git_dirty`, chat provider + `MISTRAL_CHAT_MODEL` /
OpenRouter knobs, OCR model + `OCR_MARKDOWN_CLEAN`, `text_threshold`, combined
`corpus_hash` / `golden_hash`, and `snapshot_fingerprint`. `config.mode`
records `full`|`screen`, and `config.allow_unclassified` records the override.

`benchmark/compare_reports.py` (F9) refuses to compare reports whose
fingerprints differ unless `--allow-env-drift` is passed — cross-environment
comparisons were previously unsafe and invalidated baselines by hand.

### Why cold snapshots + warm-up

- `verify_or_create` persists definitions/units on first sight (first-seen
  anchor rule, AGENTS.md). Repeating a doc on a warm DB would confound
  stability with def-warm-up state. Every run therefore restores one pristine
  seeded snapshot → all runs and iterations measure the same thing.
- The fresh-DB lg-anchor ordering dependency is OBSOLETE since the matcher's
  anchor linearization (2026-08-29, `e2e/KNOWN_ISSUES.md` fix #13):
  `lg копий/мл` rows anchor the LINEAR `copies/mL` canonical wherever they
  appear, in any run order. The runner still replays the колонофлор goldens
  through the matcher with `client=None` into every rebuilt snapshot — now in
  ALPHABETICAL order (`WARMUP_CASES`, fix #14: local defs unify first-seen per
  name/id, so the pristine world must anchor the same defs as the e2e suite).
  The replay is deterministic and free, and bakes exactly the definitions
  those documents create on a real user's DB anyway.

## Loop contract (see .opencode/skills/autoresearch/SKILL.md)

baseline → ONE focused change → `--screen` probe → full verify → mechanical
verdict from `benchmark/compare_reports.py` (KEEP iff primary improves ≥ ε
0.02; ties/within-ε are discards; screens can never keep) → guards
(`pytest tests/`, `ruff check .`, `e2e/validate_offline.py` — deterministic,
own cold DB, counts in `state.json`) → journal → repeat. Scope-locked to
`app/services/extractor.py`, `app/services/matcher/`, and `benchmark/`;
isolated on the `autoresearch/extraction` branch; never commits/pushes
without human review.
