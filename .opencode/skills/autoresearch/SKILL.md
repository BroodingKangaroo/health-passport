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
  calls). Respect `max_iterations`; prefer `--runs 1 --cases <x>` probes while
  debugging, full `--runs 3` runs for keep/discard decisions.
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
   baseline guard output (incl. the current `validate_offline` failing-case /
   diff counts — they are environment-dependent):

   ```
   cd backend && venv/bin/python benchmark/run_benchmark.py --report reports/baseline.json
   ```

   Persist into `.autoresearch/state.json`: baseline primary/cost, iteration
   counter (0), change backlog, corpus N.

2. **ONE focused change per iteration** — smallest coherent edit toward one
   hypothesis (prompt tweak, matcher heuristic, caching, chunking…). Do not
   stack unrelated edits; a failed composite can't be attributed.

3. **Verify** with the same command shape (`--report reports/iter_<k>.json`).
   Exit code ≠ 0 means BROKEN — revert the change, journal it, continue next
   iteration (don't burn iterations on repeated auth/quota breakage; stop and
   tell the user).

4. **Keep rule**: compute Δprimary = new_primary − best_so_far.
   - Keep iff `Δprimary ≥ 0.02` (epsilon margin — protects against noise,
     extraction is LLM-flaky).
   - Within ε but strictly positive: it's noise territory — discard by
     default; at most once per session MAY re-run verify once and keep only
     if still ≥ 0 ahead after that confirmation.
   - Ties/negative: DISCARD (`git checkout -- <files>` or restore from the
     iteration-start commit on `autoresearch/extraction`). Cost matters only
     as tie-break (equal primary ⇒ prefer lower input_tokens/output_tokens).
   - Also honor cost regression guard: if Δprimary ≥ ε but wall_s or tokens
     balloon >2× baseline, flag prominently in the journal for human review.

5. **Guards before any keep**:
   - `pytest tests/` and `ruff check .` must PASS outright.
   - `validate_offline.py` may have pre-existing environment-dependent diffs
     (dev-DB first-seen unit anchors vs goldens) — compare against the
     BASELINE recorded in step 1: the guard fails only if the number of
     failing cases or total diffs INCREASES versus baseline.

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

## State & resumability

`.autoresearch/state.json` + `.autoresearch/autoresearch.md` are gitignored
session memory. On resume: read them first, re-verify current HEAD state on
`autoresearch/extraction` (changed-line check via `git status` + last report),
and continue from the recorded iteration counter. Long sessions should let
context auto-compact between iterations; the state files carry continuity.

## Reporting format (end of run)

Summarize: iterations used/kept/discarded, primary baseline→final, token cost
baseline→final, list kept commits for review, and any BROKEN events. Then ask
the human whether to merge anything into their working branch.
