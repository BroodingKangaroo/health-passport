#!/usr/bin/env python3
"""Mechanical keep/discard comparison of two benchmark reports (ISSUES.md F9).

    venv/bin/python benchmark/compare_reports.py BASELINE.json NEW.json

Verdict rules implement the quality keep rule of
`.opencode/skills/autoresearch/SKILL.md`:

- **BROKEN**  — missing/foreign metric version or a required block; a
  cross-fingerprint comparison (different git/env/corpus world, ISSUES.md F8)
  without ``--allow-env-drift``; unclassified diffs in a run that did not allow
  them. No keep/discard decision may be based on it.
- **POLLUTED** — either report has ``fallback_extractions`` /
  ``provider_error_calls`` / ``chat_failovers`` > 0: environment-suspect, the
  loop re-runs once and never keeps/discards on it.
- **KEEP**    — ``Δprimary ≥ epsilon`` on a full (runs ≥ 3) report.
- **DISCARD** — everything else: negative/zero/within-epsilon deltas, and any
  ``--screen`` (runs=1) report — screens gate full verifies, they are never
  keep material.

Cost ratios (input/output tokens, wall_s) are reported against the >2×
cost-regression guard and flag the keep for human review; per SKILL.md a cost
regression does not silently veto an otherwise valid quality keep. On an exact
primary tie the cheaper side is reported as `cost_tie_break` (informational
only — F15 will decide whether cost becomes load-bearing).

Exit codes: 0 KEEP, 1 DISCARD, 2 BROKEN, 3 POLLUTED (report_schema).
"""

import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from benchmark.report_schema import (  # noqa: E402
    FINGERPRINT_FIELDS,
    METRIC_VERSION,
    VERDICT_EXIT_CODES,
)

EPSILON = 0.02
COST_REGRESSION_RATIO = 2.0


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="Compare two benchmark reports into a keep/discard verdict")
    ap.add_argument("baseline", help="baseline report JSON")
    ap.add_argument("new", help="candidate report JSON")
    ap.add_argument("--epsilon", type=float, default=EPSILON,
                    help=f"keep margin on Δprimary (default {EPSILON})")
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


def _fingerprint_mismatches(base: dict, new: dict) -> list[dict]:
    bc = base.get("config") or {}
    nc = new.get("config") or {}
    return [
        {"field": f, "baseline": bc.get(f), "new": nc.get(f)}
        for f in FINGERPRINT_FIELDS if bc.get(f) != nc.get(f)
    ]


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


def compare_reports(baseline: dict, new: dict, epsilon: float = EPSILON,
                    allow_env_drift: bool = False,
                    allow_unclassified: bool = False) -> dict:
    """Pure verdict computation (no I/O); see module docstring for the rules."""
    base_agg = baseline.get("aggregate") or {}
    new_agg = new.get("aggregate") or {}
    result: dict = {
        "baseline_primary": base_agg.get("primary"),
        "new_primary": new_agg.get("primary"),
        "epsilon": epsilon,
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
            "fingerprint mismatch (different code/env/corpus world) — "
            "rerun on the same world or pass --allow-env-drift"
        )
        return result
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
    if delta >= epsilon:
        result["promising"] = True
        if is_screen:
            result["verdict"] = "DISCARD"
            result["reasons"].append(
                "Δprimary >= epsilon but the new report is a screen (runs < 3) — "
                "run the full verify before any keep"
            )
        else:
            result["verdict"] = "KEEP"
            result["reasons"].append(f"Δprimary {delta:+.4f} >= epsilon {epsilon}")
    else:
        result["verdict"] = "DISCARD"
        result["reasons"].append(
            f"Δprimary {delta:+.4f} < epsilon {epsilon} "
            "(ties/within-margin are discards per SKILL.md)"
        )
    if result["cost_tie_break"] == "new":
        result["reasons"].append(
            "exact primary tie: the cost tie-break favors the new report "
            "(informational; verdict remains DISCARD until F15)"
        )
    if regressions:
        result["reasons"].append(
            f"cost regression > {COST_REGRESSION_RATIO}× on {regressions} — "
            "flag for human review (does not veto a valid quality keep)"
        )
    if result["case_regressions"]:
        result["reasons"].append(
            f"per-case regression(s): {result['case_regressions']} — a single "
            "improved case must not mask a case-level drop"
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
                             allow_unclassified=args.allow_unclassified)

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
    print(f"Δprimary = {result.get('delta_primary')} (epsilon {args.epsilon})")
    df = result.get("doc_fidelity") or {}
    if df:
        print(f"doc_fidelity: baseline={df.get('baseline')} new={df.get('new')} "
              f"delta={df.get('delta')}")
    extras = result.get("extras_stable") or {}
    if extras:
        print(f"extras_stable: baseline={extras.get('baseline')} new={extras.get('new')}")

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

    print(f"\nVERDICT: {result['verdict']}")
    for reason in result["reasons"]:
        print(f"  - {reason}")
    return VERDICT_EXIT_CODES.get(result["verdict"], 2)


if __name__ == "__main__":
    sys.exit(main())
