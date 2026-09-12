#!/usr/bin/env python3
"""Mechanical keep/discard comparison of two benchmark reports (ISSUES.md F9/F15).

    venv/bin/python benchmark/compare_reports.py BASELINE.json NEW.json

Verdict rules implement the quality keep rule of
`.opencode/skills/autoresearch/SKILL.md`:

- **BROKEN**  — missing/foreign metric version or a required block; a
  cross-fingerprint comparison (different env/corpus world, ISSUES.md F8)
  without ``--allow-env-drift``; unclassified diffs in a run that did not allow
  them. No keep/discard decision may be based on it. Code drift (git
  HEAD/dirty + the pipeline half of the snapshot fingerprint) is the loop's
  A/B variable: it is recorded as informational ``code_drift`` and never
  vetoes a verdict.
- **POLLUTED** — either report has ``fallback_extractions`` /
  ``provider_error_calls`` / ``chat_failovers`` > 0: environment-suspect, the
  loop re-runs once and never keeps/discards on it.
- **KEEP**    — a full (runs ≥ 3) report with no per-case non-regression gate
  violation (F15) on one of three paths:
    1. *quality*: ``Δprimary ≥ 0.02`` (fixed cap, protects against noise);
    2. *noise-aware*: positive ``Δprimary ≥ ε_eff`` (relative epsilon, 25% of
       the remaining primary headroom, floor 0.002) AND the paired bootstrap
       CI over per-run recognition excludes 0 — keeps small real gains once
       the corpus headroom drops below the fixed cap;
    3. *cost*: quality non-inferior within ε_eff AND a ≥25% win on
       input/output tokens or ``wall_s`` with no >2× regression elsewhere.
- **DISCARD** — everything else: negative/within-margin deltas, any
  ``--screen`` (runs=1) report — screens gate full verifies, they are never
  keep material (a cost win still marks the screen ``promising``).

The per-case non-regression gate (F15) vetoes any keep when a case's
recognition drops in a majority of paired runs by ≥5 points — a consistent,
material loss. A single contaminated run (the documented visit-replay flake)
or a sub-5-point wobble is treated as LLM noise. Reports without per-run
vectors fall back to an aggregate 5-point drop on recognition or stability.

Cost ratios (input/output tokens, wall_s) are reported against the >2×
cost-regression guard; a cost regression vetoes the *cost* keep path and
flags any other keep for human review (per SKILL.md a cost regression does
not silently veto a valid quality keep). On an exact primary tie the cheaper
side is reported as `cost_tie_break` (informational unless it clears the
cost keep path).

Exit codes: 0 KEEP, 1 DISCARD, 2 BROKEN, 3 POLLUTED (report_schema).
"""

import argparse
import json
import math
import os
import random
import sys
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from benchmark.report_schema import (  # noqa: E402
    CODE_DRIFT_FIELDS,
    FINGERPRINT_FIELDS,
    METRIC_VERSION,
    VERDICT_EXIT_CODES,
)

EPSILON = 0.02
COST_REGRESSION_RATIO = 2.0
# F15 objective redesign.
HEADROOM_EPSILON_FRACTION = 0.25
MIN_EPSILON = 0.002
COST_WIN_RATIO = 0.25
CASE_REGRESSION_MIN_DROP = 0.05
BOOTSTRAP_ITERATIONS = 2000
BOOTSTRAP_SEED = 20260912


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="Compare two benchmark reports into a keep/discard verdict")
    ap.add_argument("baseline", help="baseline report JSON")
    ap.add_argument("new", help="candidate report JSON")
    ap.add_argument("--epsilon", type=float, default=None,
                    help="absolute keep margin on Δprimary (disables relative "
                         f"scaling; default: relative, capped at {EPSILON})")
    ap.add_argument("--cost-win", type=float, default=COST_WIN_RATIO,
                    help="fractional token/wall_s win (0-1) that enables the "
                         f"cost keep path (default {COST_WIN_RATIO})")
    ap.add_argument("--allow-env-drift", action="store_true",
                    help="compare across fingerprint differences (unsafe; debugging only)")
    ap.add_argument("--allow-unclassified", action="store_true",
                    help="do not treat unclassified diffs as BROKEN")
    ap.add_argument("--json", action="store_true", help="print the verdict object as JSON")
    return ap.parse_args(argv)


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _pollution(report: dict) -> dict:
    metrics = report.get("metrics") or {}
    return {
        "fallback_extractions": int(metrics.get("fallback_extractions") or 0),
        "provider_error_calls": int(metrics.get("provider_error_calls") or 0),
        "chat_failovers": int(report.get("chat_failovers") or 0),
    }


def _field_mismatches(base: dict, new: dict, fields) -> list[dict]:
    bc = base.get("config") or {}
    nc = new.get("config") or {}
    return [
        {"field": f, "baseline": bc.get(f), "new": nc.get(f)}
        for f in fields if bc.get(f) != nc.get(f)
    ]


def _fingerprint_mismatches(base: dict, new: dict) -> list[dict]:
    return _field_mismatches(base, new, FINGERPRINT_FIELDS)


def _ratio(new_value, base_value):
    new_value = new_value or 0
    base_value = base_value or 0
    if base_value == 0:
        return None if new_value == 0 else float("inf")
    return round(new_value / base_value, 3)


def _case_deltas(base: dict, new: dict) -> dict:
    bcases = base.get("cases") or {}
    ncases = new.get("cases") or {}
    deltas = {}
    for name in sorted(set(bcases) | set(ncases)):
        b = bcases.get(name) or {}
        n = ncases.get(name) or {}
        d = {}
        for key in ("recognition", "stability", "doc_fidelity"):
            if b.get(key) is not None and n.get(key) is not None:
                d[key] = round(n[key] - b[key], 4)
        if d:
            deltas[name] = d
    return deltas


def _per_run_vectors(report: dict) -> dict:
    """Per-case ``per_run_recognition`` vectors (case -> list of run values)."""
    out = {}
    for name, case in (report.get("cases") or {}).items():
        recs = [float(v) for v in (case.get("per_run_recognition") or [])
                if v is not None]
        if recs:
            out[name] = recs
    return out


def _recognition_ci(baseline: dict, new: dict,
                    iterations: int = BOOTSTRAP_ITERATIONS,
                    seed: int = BOOTSTRAP_SEED):
    """Bootstrap 95% CI of the aggregate recognition difference (F15).

    Resamples cases with replacement and one run per sampled case on each side
    independently: the two reports are different time windows, so runs are not
    paired. Returns ``None`` when neither report carries per-run vectors
    (older reports) — the verdict then falls back to the fixed cap only.
    """
    b = _per_run_vectors(baseline)
    n = _per_run_vectors(new)
    common = sorted(set(b) & set(n))
    if not common:
        return None
    rng = random.Random(seed)
    diffs = []
    for _ in range(iterations):
        sampled = [rng.choice(common) for _ in common]
        b_mean = sum(rng.choice(b[c]) for c in sampled) / len(sampled)
        n_mean = sum(rng.choice(n[c]) for c in sampled) / len(sampled)
        diffs.append(n_mean - b_mean)
    diffs.sort()
    low = diffs[max(0, int(0.025 * iterations))]
    high = diffs[min(iterations - 1, int(0.975 * iterations))]
    return {
        "low": round(low, 4),
        "high": round(high, 4),
        "mean": round(sum(diffs) / iterations, 4),
        "cases": len(common),
        "iterations": iterations,
        "seed": seed,
    }


def _effective_epsilon(baseline_primary, epsilon):
    """F15 relative epsilon: 25% of the remaining primary headroom, floor
    ``MIN_EPSILON``, capped at the fixed ``EPSILON``. An explicit ``epsilon``
    argument is absolute and disables scaling."""
    if epsilon is not None:
        return round(float(epsilon), 6)
    headroom = max(0.0, 1.0 - float(baseline_primary or 0.0))
    scaled = HEADROOM_EPSILON_FRACTION * headroom
    return round(min(EPSILON, max(scaled, MIN_EPSILON)), 6)


def _case_gate(base: dict, new: dict) -> list:
    """Per-case non-regression gate (F15).

    A case vetoes the keep when its recognition drops in a strict majority of
    paired runs by at least ``CASE_REGRESSION_MIN_DROP`` — a consistent,
    material loss. A single contaminated run (the documented visit-replay
    flake) or a sub-5-point wobble is LLM noise and does not veto. Reports
    without per-run vectors (older runs) fall back to the aggregate 5-point
    drop on recognition or stability.
    """
    bcases = base.get("cases") or {}
    ncases = new.get("cases") or {}
    violations = []
    for name in sorted(set(bcases) & set(ncases)):
        b = bcases.get(name) or {}
        n = ncases.get(name) or {}
        bvec = [float(v) for v in (b.get("per_run_recognition") or [])
                if v is not None]
        nvec = [float(v) for v in (n.get("per_run_recognition") or [])
                if v is not None]
        if bvec and nvec:
            runs = min(len(bvec), len(nvec))
            worse = sum(1 for i in range(runs) if nvec[i] < bvec[i] - 1e-9)
            mean_delta = (sum(nvec[:runs]) - sum(bvec[:runs])) / runs
            if worse * 2 > runs and mean_delta <= -CASE_REGRESSION_MIN_DROP:
                violations.append({
                    "case": name,
                    "metric": "recognition",
                    "delta": round(mean_delta, 4),
                    "runs_worse": worse,
                    "runs": runs,
                    "threshold": CASE_REGRESSION_MIN_DROP,
                })
            continue
        for metric in ("recognition", "stability"):
            bv = b.get(metric)
            nv = n.get(metric)
            if bv is None or nv is None:
                continue
            if nv - bv <= -CASE_REGRESSION_MIN_DROP + 1e-9:
                violations.append({
                    "case": name,
                    "metric": metric,
                    "delta": round(nv - bv, 4),
                    "threshold": CASE_REGRESSION_MIN_DROP,
                })
    return violations


def compare_reports(baseline: dict, new: dict, epsilon: Optional[float] = None,
                    allow_env_drift: bool = False,
                    allow_unclassified: bool = False,
                    cost_win_ratio: float = COST_WIN_RATIO,
                    bootstrap_iterations: int = BOOTSTRAP_ITERATIONS) -> dict:
    """Pure verdict computation (no I/O); see module docstring for the rules."""
    base_agg = baseline.get("aggregate") or {}
    new_agg = new.get("aggregate") or {}
    result: dict = {
        "baseline_primary": base_agg.get("primary"),
        "new_primary": new_agg.get("primary"),
        "epsilon": (epsilon if epsilon is not None else EPSILON),
        "verdict": "BROKEN",
        "reasons": [],
        "promising": False,
    }

    if not base_agg or not new_agg:
        result["reasons"].append("missing aggregate block in one or both reports")
        return result

    new_config = new.get("config") or {}
    base_config = baseline.get("config") or {}
    if new_config.get("metric_version") != METRIC_VERSION:
        result["reasons"].append(
            f"new report metric_version={new_config.get('metric_version')!r} "
            f"(current is {METRIC_VERSION})"
        )
        return result
    if base_config.get("metric_version") != METRIC_VERSION:
        result["reasons"].append(
            f"baseline report metric_version={base_config.get('metric_version')!r} "
            f"(current is {METRIC_VERSION})"
        )
        return result

    mismatches = _fingerprint_mismatches(baseline, new)
    result["fingerprint_mismatches"] = mismatches
    result["code_drift"] = _field_mismatches(baseline, new, CODE_DRIFT_FIELDS)
    result["env_drift_allowed"] = allow_env_drift

    pollution = {"baseline": _pollution(baseline), "new": _pollution(new)}
    result["pollution"] = pollution
    polluted = any(v > 0 for side in pollution.values() for v in side.values())

    unclassified = int(new.get("unclassified_total") or 0)
    # Only the CANDIDATE's config (or the CLI flag) excuses unclassified
    # diffs: a one-off excuse recorded in the baseline must not mask every
    # future candidate.
    unclassified_allowed = (allow_unclassified
                            or bool(new_config.get("allow_unclassified")))
    result["unclassified_total"] = unclassified
    result["unclassified_allowed"] = unclassified_allowed

    delta = round((new_agg.get("primary") or 0.0) - (base_agg.get("primary") or 0.0), 4)
    result["delta_primary"] = delta
    result["doc_fidelity"] = {
        "baseline": base_agg.get("doc_fidelity"),
        "new": new_agg.get("doc_fidelity"),
        "delta": (round(new_agg["doc_fidelity"] - base_agg["doc_fidelity"], 4)
                  if base_agg.get("doc_fidelity") is not None
                  and new_agg.get("doc_fidelity") is not None else None),
    }
    result["extras_stable"] = {
        "baseline": base_agg.get("extras_stable"),
        "new": new_agg.get("extras_stable"),
    }
    result["case_deltas"] = _case_deltas(baseline, new)
    result["case_regressions"] = [
        {"case": name, **{k: v for k, v in d.items()
                          if k in ("recognition", "stability") and v < 0}}
        for name, d in result["case_deltas"].items()
        if any(d.get(k, 0) < 0 for k in ("recognition", "stability"))
    ]
    result["case_sets_match"] = sorted(
        base_config.get("cases") or []) == sorted(new_config.get("cases") or [])
    result["case_gate"] = _case_gate(baseline, new)

    epsilon_fixed = (epsilon if epsilon is not None else EPSILON)
    result["epsilon_fixed"] = epsilon_fixed
    result["epsilon_effective"] = _effective_epsilon(base_agg.get("primary"), epsilon)
    result["recognition_ci"] = _recognition_ci(
        baseline, new, iterations=bootstrap_iterations)

    bm = baseline.get("metrics") or {}
    nm = new.get("metrics") or {}
    cost = {
        "input_tokens": _ratio(nm.get("input_tokens"), bm.get("input_tokens")),
        "output_tokens": _ratio(nm.get("output_tokens"), bm.get("output_tokens")),
        "wall_s": _ratio(new.get("wall_s"), baseline.get("wall_s")),
    }
    regressions = [k for k, v in cost.items()
                   if v is not None and v > COST_REGRESSION_RATIO]
    result["cost_ratios"] = cost
    result["cost_regression"] = regressions
    result["cost_win_ratio"] = cost_win_ratio
    result["cost_wins"] = {k: v for k, v in cost.items()
                           if v is not None and v <= 1.0 - cost_win_ratio}
    if delta == 0:
        ratios = [v for v in cost.values() if v is not None]
        if any(v < 1.0 for v in ratios):
            result["cost_tie_break"] = "new"
        elif any(v > 1.0 for v in ratios):
            result["cost_tie_break"] = "baseline"
        else:
            result["cost_tie_break"] = None
    else:
        result["cost_tie_break"] = None

    if mismatches and not allow_env_drift:
        result["reasons"].append(
            "fingerprint mismatch (different env/corpus world) — "
            "rerun on the same world or pass --allow-env-drift"
        )
        return result
    if result["code_drift"]:
        fields = ", ".join(d["field"] for d in result["code_drift"])
        result["reasons"].append(
            f"code drift recorded (informational, not a veto): {fields}"
        )
    if unclassified and not unclassified_allowed:
        result["reasons"].append(
            f"{unclassified} unclassified diff(s) — scoring parser cannot attribute them"
        )
        return result
    if polluted:
        counters = {f"{side}.{k}": v
                    for side, counters_ in pollution.items()
                    for k, v in counters_.items() if v > 0}
        result["reasons"].append(f"pollution counters > 0: {counters} — rerun once")
        result["verdict"] = "POLLUTED"
        return result

    is_screen = (new_config.get("mode") == "screen"
                 or (new_config.get("runs") or 0) < 3)
    ci = result["recognition_ci"]
    ci_low = ci.get("low") if ci else None
    eps_eff = result["epsilon_effective"]

    # F15 keep paths: strong quality (fixed cap), noise-aware small gain
    # (relative epsilon + recognition CI excluding 0), or cost win on a
    # quality-non-inferior report. The per-case gate vetoes all of them.
    strong = delta >= epsilon_fixed
    noise_aware = (not strong and delta > 0 and delta >= eps_eff
                   and ci_low is not None and ci_low > 0)
    cost_non_inferior = (delta >= -eps_eff
                         and (ci_low is None or ci_low >= -eps_eff))
    cost_keep = (not regressions and bool(result["cost_wins"])
                 and cost_non_inferior)
    would_keep = strong or noise_aware or cost_keep
    result["promising"] = would_keep
    result["keep_basis"] = None

    if would_keep and result["case_gate"]:
        result["verdict"] = "DISCARD"
        result["reasons"].append(
            f"per-case non-regression gate failed (F15): {result['case_gate']} — "
            "a full item's worth of case-level loss must not be masked by an "
            "improved case"
        )
    elif would_keep and is_screen:
        result["verdict"] = "DISCARD"
        result["reasons"].append(
            "keep conditions met but the new report is a screen (runs < 3) — "
            "run the full verify before any keep"
        )
    elif would_keep:
        result["verdict"] = "KEEP"
        if strong:
            result["keep_basis"] = "quality"
            result["reasons"].append(
                f"Δprimary {delta:+.4f} >= epsilon {epsilon_fixed}"
            )
        elif noise_aware:
            result["keep_basis"] = "noise-aware"
            result["reasons"].append(
                f"Δprimary {delta:+.4f} >= relative epsilon {eps_eff} and the "
                f"recognition CI [{ci_low:+.4f}, {ci['high']:+.4f}] excludes 0"
            )
        else:
            result["keep_basis"] = "cost"
            wins = ", ".join(_fmt_ratio(k, v)
                             for k, v in result["cost_wins"].items())
            result["reasons"].append(
                f"cost keep: Δprimary {delta:+.4f} is non-inferior within "
                f"epsilon {eps_eff} and {wins} clears the "
                f"{cost_win_ratio:.0%} win threshold"
            )
    else:
        result["verdict"] = "DISCARD"
        if delta >= eps_eff and delta > 0 and ci_low is not None and ci_low <= 0:
            result["reasons"].append(
                f"Δprimary {delta:+.4f} >= relative epsilon {eps_eff} but the "
                f"recognition CI [{ci_low:+.4f}, {ci['high']:+.4f}] includes 0 "
                "— noise territory"
            )
        else:
            result["reasons"].append(
                f"Δprimary {delta:+.4f} < epsilon {eps_eff} "
                "(ties/within-margin are discards per SKILL.md)"
            )
        if result["cost_wins"] and regressions:
            result["reasons"].append(
                f"cost win vetoed by >{COST_REGRESSION_RATIO}× regression on "
                f"{regressions}"
            )
        elif result["cost_wins"] and not cost_non_inferior:
            result["reasons"].append(
                f"cost win vetoed: Δprimary {delta:+.4f} is outside the "
                f"non-inferiority margin {eps_eff}"
            )
    if result["cost_tie_break"] == "new":
        result["reasons"].append(
            "exact primary tie: the cost tie-break favors the new report "
            "(below the cost-keep threshold — informational)"
        )
    if regressions:
        result["reasons"].append(
            f"cost regression > {COST_REGRESSION_RATIO}× on {regressions} — "
            "flag for human review (does not veto a valid quality keep)"
        )
    if result["case_regressions"]:
        result["reasons"].append(
            f"per-case regression(s) below the gate threshold: "
            f"{result['case_regressions']} (informational)"
        )
    if not result["case_sets_match"]:
        result["reasons"].append(
            "case sets differ (subset/screen vs full) — per-case deltas are the "
            "only comparable signal"
        )
    return result


def _json_safe(value):
    """Strict-JSON-ify non-finite floats (a zero-cost baseline yields inf)."""
    if isinstance(value, float) and not math.isfinite(value):
        return "inf" if value > 0 else "-inf"
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def _fmt_ratio(key: str, value) -> str:
    if value is None:
        return f"{key}=n/a"
    if value == float("inf"):
        return f"{key}=inf"
    return f"{key}=x{value}"


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        baseline = _load(args.baseline)
        new = _load(args.new)
    except (OSError, ValueError) as e:
        print(f"BROKEN: cannot read report: {e}", file=sys.stderr)
        return VERDICT_EXIT_CODES["BROKEN"]

    result = compare_reports(baseline, new, epsilon=args.epsilon,
                             allow_env_drift=args.allow_env_drift,
                             allow_unclassified=args.allow_unclassified,
                             cost_win_ratio=args.cost_win)

    if args.json:
        print(json.dumps(_json_safe(result), indent=2, ensure_ascii=False))
        return VERDICT_EXIT_CODES.get(result["verdict"], 2)

    bc = baseline.get("config") or {}
    nc = new.get("config") or {}
    print("=== benchmark report comparison ===")
    print(f"baseline: {args.baseline}  primary={result['baseline_primary']}  "
          f"mode={bc.get('mode', 'full')}  runs={bc.get('runs')}  "
          f"git={str(bc.get('git_head'))[:10]}")
    print(f"new:      {args.new}  primary={result['new_primary']}  "
          f"mode={nc.get('mode', 'full')}  runs={nc.get('runs')}  "
          f"git={str(nc.get('git_head'))[:10]}")
    print(f"Δprimary = {result.get('delta_primary')} "
          f"(epsilon fixed {result.get('epsilon_fixed')}, "
          f"effective {result.get('epsilon_effective')})")
    df = result.get("doc_fidelity") or {}
    if df:
        print(f"doc_fidelity: baseline={df.get('baseline')} new={df.get('new')} "
              f"delta={df.get('delta')}")
    extras = result.get("extras_stable") or {}
    if extras:
        print(f"extras_stable: baseline={extras.get('baseline')} new={extras.get('new')}")
    ci = result.get("recognition_ci")
    if ci:
        print(f"recognition CI 95%: [{ci['low']:+.4f}, {ci['high']:+.4f}] "
              f"(mean {ci['mean']:+.4f}; {ci['cases']} cases, "
              f"{ci['iterations']} bootstrap draws)")
    else:
        print("recognition CI 95%: n/a (no per-run recognition vectors)")
    if result.get("case_gate"):
        print("per-case non-regression gate:")
        for v in result["case_gate"]:
            extra = (f"{v['runs_worse']}/{v['runs']} runs worse"
                     if "runs_worse" in v else "aggregate")
            print(f"  {v['case']}: {v['metric']} {v['delta']:+.4f} "
                  f"(threshold -{v['threshold']}; {extra})")

    mismatches = result.get("fingerprint_mismatches") or []
    if mismatches:
        print("fingerprint mismatches:")
        for m in mismatches:
            print(f"  - {m['field']}: {m['baseline']!r} -> {m['new']!r}")
    else:
        print("fingerprint: OK")
    polluted = {f"{side}.{k}": v
                for side, counters in (result.get("pollution") or {}).items()
                for k, v in counters.items() if v > 0}
    print(f"pollution: {polluted or 'clean'}")
    cost = result.get("cost_ratios") or {}
    if cost:
        print("cost ratios: " + ", ".join(_fmt_ratio(k, v) for k, v in cost.items())
              + f" (guard >{COST_REGRESSION_RATIO}x)")
    if result.get("cost_tie_break"):
        print(f"cost tie-break: {result['cost_tie_break']} (informational)")
    if result.get("case_deltas"):
        print("per-case deltas:")
        for name, d in result["case_deltas"].items():
            parts = ", ".join(f"{k} {v:+.4f}" for k, v in d.items())
            print(f"  {name}: {parts}")

    basis = result.get("keep_basis")
    print(f"\nVERDICT: {result['verdict']}" + (f" ({basis})" if basis else ""))
    for reason in result["reasons"]:
        print(f"  - {reason}")
    return VERDICT_EXIT_CODES.get(result["verdict"], 2)


if __name__ == "__main__":
    sys.exit(main())
