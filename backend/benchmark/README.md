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
  OCR `usage_info.doc_size_bytes` fallback), `wall_s` (sum of run walls).

### Why cold snapshots + warm-up

- `verify_or_create` persists definitions/units on first sight (first-seen
  anchor rule, AGENTS.md). Repeating a doc on a warm DB would confound
  stability with def-warm-up state. Every run therefore restores one pristine
  seeded snapshot → all runs and iterations measure the same thing.
- The fresh-DB lg-anchor ordering dependency (`e2e/KNOWN_ISSUES.md`: both
  колонофлор cases fail when `lg копий/мл` anchors first) is handled the same
  way as the e2e convention: the runner replays the колонофлор_16_25.06
  golden through the matcher with `client=None` into every rebuilt snapshot so
  linear `copies/mL` anchors first. That replay is deterministic and free, and
  bakes exactly the definitions those documents create on a real user's DB
  anyway.

## Loop contract (see .opencode/skills/autoresearch/SKILL.md)

baseline → ONE focused change → run this verify command → keep iff primary
improves ≥ ε (0.02; ties broken by lower cost) → guards (`pytest tests/`,
`ruff check .`, `e2e/validate_offline.py`) → journal → repeat. Scope-locked
to `app/services/extractor.py`, `app/services/matcher/`, and `benchmark/`;
isolated on the `autoresearch/extraction` branch; never commits/pushes
without human review.
