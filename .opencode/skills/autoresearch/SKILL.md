---
name: autoresearch
description: Use when running or resuming the extraction quality/cost optimization loop ("autoresearch", "run the optimization loop", "improve extraction metrics") over backend/benchmark/run_benchmark.py. Covers the baseline→change→verify→keep/discard procedure, guards, scope-lock, git isolation on autoresearch/extraction, and the no-pkill/no-main-commit safety rules.
---

# HealthPassport autoresearch loop (extraction quality/cost)

Autonomous long-running loop that improves live extraction **recognition ×
stability** without regressing cost. Metric source of truth:
`backend/benchmark/run_benchmark.py` (see `backend/benchmark/README.md`).
Original proposal: ISSUES.md #24 (git history).

## Safety rules (absolute)

- **Cost**: every verify run is REAL Mistral spend (~cases × N × up-to-10 LLM
  calls). Respect `max_iterations`; a full `--runs 3` verify takes ~15–25 min
  with default parallelism (`--jobs 3 --stage-concurrency 2`; ~66 min with
  `--jobs 1`), so screen cheaply first (see step 3) before every full run.
- **Git isolation**: work ONLY on branch `autoresearch/extraction`. Never
  commit to `main`, never push, never rebase over user branches. Every keep
  is presented for human review — do not merge yourself.
- **Server rules**: the benchmark never boots servers or touches ports
  (pure library runner). Never `pkill uvicorn`, never touch port 8000.
- **Off-limits paths** (never edit): `app/db/seed_loinc*`, `backend/data/*`
  (incl. `Loinc.csv`), e2e goldens, `benchmark/corpus/**` goldens, any DB file.
  If a metric gain requires those, STOP and report instead.

## Scope lock

Allowed targets: `backend/app/services/extractor.py`,
`backend/app/services/matcher/` (whole package),
`backend/app/api/ai.py`, and `backend/benchmark/` itself.
Everything else is off-limits except README/journal state described below.

## Loop procedure

1. **Baseline**: record `git rev-parse HEAD`, the verification report, and
   baseline guard output (the `validate_offline` failing-case / diff counts are
   now deterministic — it runs against its own cold seeded DB, F13):

   ```
   cd backend && venv/bin/python benchmark/run_benchmark.py --report reports/baseline.json
   ```

   The report carries the full reproducibility fingerprint (git HEAD/dirty,
   chat provider/model knobs, OCR model/cleaner, corpus + golden hashes,
   `snapshot_fingerprint`, `metric_version` — F8). Persist into
   `.autoresearch/state.json` **schema v2**: `session.iteration` (0),
   `baseline.{status,head,report,metrics}`, `corpus.splits`, `guards.baseline`,
   `fingerprints.snapshot_inputs`, and an append-only `history` entry. Never
   rewrite earlier `history` entries; append.

2. **ONE focused change per iteration** — smallest coherent edit toward one
   hypothesis (prompt tweak, matcher heuristic, caching, chunking…). Do not
   stack unrelated edits; a failed composite can't be attributed.

3. **Verify (two-stage)**:
   - **Screen cheaply first**: `--screen --cases <targeted,...>
     --report reports/screen_<k>.json` (runs=1, a control case is appended
     automatically, report is marked `mode=screen`). Translator-adjacent
     changes are blind to bimodal flapping at N=1 (the рнпц case once scored
     perfect at N=1 and collapsed to 0 at N=3) — probe twice or go straight
     to a full verify when in doubt. A clearly negative screen discards the
     change without a full run.
   - **Full verify** for any promising screen and ALWAYS for the keep
     decision: `--runs 3` over the WHOLE corpus, same command shape
     (`--report reports/iter_<k>.json`). Exit code ≠ 0 means BROKEN — revert
     the change, journal it, continue next iteration (don't burn iterations
     on repeated auth/quota breakage; stop and tell the user). Non-zero
     `unclassified` diffs already exit 2 unless `--allow-unclassified`.
   - **Pollution guard**: a run whose METRICS block has
     `fallback_extractions > 0` OR `provider_error_calls > 0` OR
     `chat_failovers > 0` is ENVIRONMENT-SUSPECT (provider storm, rate-limit
     backoff exhausted, silent LLM fallbacks, or mixed-provider weather from
     mistral→OpenRouter failover) — it is NOT evidence about the change.
     Auto-rerun the same command ONCE (bounded); decide on the clean rerun.
     If pollution repeats, STOP and tell the user. Never keep or discard on
     a polluted run.

4. **Keep rule**: get the verdict mechanically — this is the only sanctioned
   decision path (F9):

   ```
   cd backend && venv/bin/python benchmark/compare_reports.py reports/baseline_v6.json reports/iter_<k>.json
   ```

   Exit codes: 0 KEEP, 1 DISCARD, 2 BROKEN (fingerprint/version/unclassified),
   3 POLLUTED. Add `--allow-env-drift` only for debugging, never for a keep.
   The script encodes the rule below; the human-readable spec stays here so
   the rule is auditable:

   - Keep iff `Δprimary ≥ 0.02` (epsilon margin — protects against noise,
     extraction is LLM-flaky). A `mode=screen` report can never KEEP (run the
     full verify first) — the script enforces this.
   - Within ε but strictly positive: it's noise territory — discard by
     default; at most once per session MAY re-run verify once and keep only
     if still ≥ 0 ahead after that confirmation.
   - Ties/negative: DISCARD (`git checkout -- <files>` or restore from the
     iteration-start commit on `autoresearch/extraction`). `compare_reports`
     reports which side an exact primary tie favors on cost
     (`cost_tie_break`), but that stays informational until F15 makes cost
     load-bearing.
   - Also honor cost regression guard: if Δprimary ≥ ε but `wall_s` (sum of
     run walls — NOT `wall_clock_s`, which shrinks when runs execute in
     parallel) or tokens balloon >2× baseline, flag prominently in the
     journal for human review.

5. **Guards before any keep**:
   - `pytest tests/` and `ruff check .` must PASS outright.
   - `venv/bin/python -m e2e.validate_offline` runs against its own cold
     seeded work DB (F13) and is deterministic; the comparator threshold is
     unified with the benchmark at 0.9. Compare failing-case / total-diff
     counts against `guards.baseline.validate_offline` in state.json: the
     guard fails only if either INCREASES.
   - Record the three guard results in `state.json` (`guards.latest`) in the
     same step — no prose-only guard memory.

6. **Journal** `.autoresearch/autoresearch.md` (gitignored): iteration k,
   hypothesis, files touched, metric deltas (primary/recognition/stability/
   tokens), keep|discard, guard status. Update `.autoresearch/state.json`.

7. Repeat until `max_iterations` (default 10) — HARD cap — or the backlog is
   empty. Never continue past cap silently; hand back a summary.

## Keep discipline

- Kept changes are committed ON `autoresearch/extraction` with message
  `autoresearch(iter<k>): <one-line hypothesis>` AFTER guards pass. They are
  working-tree improvements pending review, NOT releases: present the final
  table (iterations kept/discarded, primary trajectory, cost trend) to the
  user and stop — merging/cherry-picking to main is the human's call.
- Discarded iterations leave NO residue: revert fully before the next one.

## Validation ritual (before trusting the loop)

Run once per setup (and after major runner/scoring edits):

1. Sanity: `--runs 3 --cases оак_26.05` and eyeball observed vs golden
   manually (the metrics must look plausible against a known-passing case).
2. No-op dry-run: apply a deliberate no-op change (e.g. add+remove blank
   effectively cosmetic), verify the loop path discards it (primary unchanged
   within ε) and the runner prints identical METRIC keys.
3. Harness equivalence (after parallel-runner edits): run a small stable
   subset (оак + рнпц — the latter exercises full-corpus golden pinning)
   with `--jobs 1 --stage-concurrency 1` and with the default
   `--jobs 3 --stage-concurrency 2` on a stable provider window. Structure
   must agree (same cases, same METRIC keys, pollution counters 0); values
   may wobble with LLM nondeterminism but should land in the same range.

## Corpus governance (F6) — human-reviewed, NOT a loop iteration

- `benchmark/corpus/manifest.json` (tracked; the documents/goldens stay
  gitignored) records per-case document/golden hashes, source, reviewer, date
  and `split: tuning|validation`. Normal runs verify the hashes and FAIL on
  drift unless `--allow-corpus-drift`; refresh with
  `venv/bin/python benchmark/run_benchmark.py --manifest` after a reviewed
  change.
- The ~30% `validation` split is held out: never target it in screens or
  iterations. Run full-corpus verifies as usual — keep decisions still read
  the whole-corpus primary; the split exists so corpus-growth reviews can
  detect tuning-overfit.
- Adding/adjusting cases is a human activity: source document, hand-verified
  golden (e2e-golden workflow), manifest provenance, then
  `--runs 1 --cases <new>` clean + matcher-only deterministic check. The
  loop's off-limits rule for `corpus/**` goldens stays.
- `corpus` command mode: `.opencode/command/autoresearch.md corpus` — growth
  review only, no loop iterations, no metric claims.

## State & resumability (schema v2)

`.autoresearch/state.json` + `.autoresearch/autoresearch.md` are gitignored
session memory. Schema v2 fields: `schema`, `session.{iteration,
max_iterations}`, `baseline.{status,head,report,metrics}`, `epsilon`,
`metric_version`, `corpus.{cases,runs,splits,manifest}`,
`guards.{baseline,latest}`, `fingerprints.snapshot_inputs`, and an
**append-only** `history` array.

**Resume protocol (F14)** — before continuing an old state, check for world
drift:

1. `git branch --show-current` and
   `git merge-base --is-ancestor autoresearch/extraction main`: if the branch
   is missing/merged/checked out elsewhere, recreate
   `autoresearch/extraction` from current `main` (never rebase over user
   branches, never commit to `main`).
2. Compare `git rev-parse HEAD` in `baseline.head` with the current tree. If
   any scope-locked file (`app/services/extractor.py`, `app/services/matcher/`,
   `app/api/ai.py`, `benchmark/`) changed since `baseline.head`, the baseline
   is STALE: mark `baseline.status` accordingly and re-baseline with
   `--fresh-db` on the fresh branch (the report fingerprint will also differ).
   Never iterate against a stale baseline.
3. `compare_reports.py` refuses reports whose `metric_version` or fingerprint
   do not match, so a stale baseline cannot silently decide a keep.
4. Archive rotation: when starting a new session, move the previous
   `state.json`/`autoresearch.md` into `.autoresearch/archive-<date>/` before
   writing v2 state (keep exactly one previous session snapshot; the earlier
   archive-2026-08-28 is already kept).

Long sessions should let context auto-compact between iterations; the state
files carry continuity.

## Reporting format (end of run)

Summarize: iterations used/kept/discarded, primary baseline→final, token cost
baseline→final, list kept commits for review, and any BROKEN events. Then ask
the human whether to merge anything into their working branch.
