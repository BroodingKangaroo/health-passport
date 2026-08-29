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
- Own DB (`benchmark_run.db` / pristine snapshot copies); never touches
  `health_passport.db`. `seed_loinc` inside this flow drops/recreates ONLY the
  benchmark DB.
- Off-limits to the loop that consumes these metrics: `app/db/seed_loinc*`,
  `data/Loinc.csv`, e2e goldens, goldens in `corpus/`, all DB files.

## Layout

```
backend/benchmark/
  corpus/<case>/            # source document(s) + standardized.json golden
                            #   (same JSON format as backend/e2e/goldens)
  metrics.py                # instrumented Mistral wrapper: calls/tokens/bytes/stages
  scoring.py                # diff-grouping → recognition / stability aggregates
  run_benchmark.py          # THE verify command
  benchmark_run.db          # live working DB (gitignored artifact)
  benchmark_pristine.db     # snapshot template (gitignored artifact)
  reports/                  # optional --report JSON output dir (gitignored)
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

## Running

```bash
cd backend
venv/bin/python benchmark/run_benchmark.py                 # N=3 over the whole corpus
venv/bin/python benchmark/run_benchmark.py --runs 1 \
    --cases оак_26.05                                      # cheap single-case probe
venv/bin/python benchmark/run_benchmark.py --report reports/iter_01.json
```

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
  continues behind a doomed run.

With defaults (`--jobs 3 --stage-concurrency 2`) a full 9-case × 3-runs
verify drops from ~66 min to roughly 15–25 min (it is ~99% Mistral latency;
the matcher — ~half the wall — remains sequential by design).

Output ends in a machine-readable block:

```
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
```

Exit codes: **0** metrics computed (even if worse than baseline — deciding
worse vs better is the *loop's* job reading `primary`), **2** hard failure
(`MISTRAL_API_KEY` missing, OCR auth/quota), **1** unexpected crash.

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
- **primary** = `recognition × stability` — the loop's keep/discard scalar.
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
  retry/backoff gave up (5xx storms, timeouts, watchdog kills). ANY count > 0
  marks the run environment-suspect: the loop re-runs once (bounded) and
  never keeps/discards on polluted data.

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

### Why cold snapshots + warm-up

- `verify_or_create` persists definitions/units on first sight (first-seen
  anchor rule, AGENTS.md). Repeating a doc on a warm DB would confound
  stability with def-warm-up state. Every run therefore restores one pristine
  seeded snapshot → all runs and iterations measure the same thing.
- The fresh-DB lg-anchor ordering dependency is OBSOLETE since the matcher's
  anchor linearization (2026-08-29, `e2e/KNOWN_ISSUES.md` fix #13):
  `lg копий/мл` rows anchor the LINEAR `copies/mL` canonical wherever they
  appear, in any run order. The runner still replays the колонофлор_16_25.06
  golden through the matcher with `client=None` into every rebuilt snapshot —
  it is deterministic and free, and bakes exactly the definitions those
  documents create on a real user's DB anyway.

## Loop contract (see .opencode/skills/autoresearch/SKILL.md)

baseline → ONE focused change → run this verify command → keep iff primary
improves ≥ ε (0.02; ties broken by lower cost) → guards (`pytest tests/`,
`ruff check .`, `e2e/validate_offline.py`) → journal → repeat. Scope-locked
to `app/services/extractor.py`, `app/services/matcher/`, and `benchmark/`;
isolated on the `autoresearch/extraction` branch; never commits/pushes
without human review.
