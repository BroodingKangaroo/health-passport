"""Benchmark scoring: turn e2e comparator diff strings into per-case
recognition / stability numbers and aggregate them into the loop's metrics.

Semantics (documented in benchmark/README.md and derived from ISSUES.md #24):

- The "golden universe" is the set of comparable items in the golden JSON:
  one item per unique biomarker ``raw_name``, per non-empty visit field, per
  prescription/recommendation index, and per non-empty instrumental field.
  Top-level fields (entry_type/date/time/clinic/provider/title/notes) are
  outside the universe — comparator diffs for them are surfaced as
  ``top_diffs`` warnings only.
- recognition (per run) = (recognized golden items - EXTRA_PENALTY * extras)
  / |universe|, clamped to [0, 1]; extras are UNEXPECTED biomarkers plus any
  excess rows implied by count mismatches.
- stability (per case) = |intersection over runs of recognized sets| / |universe|.
- extras_stable (per case) = number of UNEXPECTED biomarker names that appeared
  in EVERY run (a consistently hallucinated row must be visible in both axes;
  it is reported alongside primary, which keeps its recognition x stability
  semantics).
- doc_fidelity (per case/run) = fraction of golden-populated top-level fields
  (entry_type/date/time/clinic/provider/title/notes) the run carried faithfully.
  This is the co-metric that lets the documented time-drop move a number even
  though top-level fields are outside the golden universe.
- Aggregates average recognition/stability across cases; primary = recognition
  x stability.

Diff-string parsing is grouped by item so a single bad row penalizes exactly
that item. ``compare.py`` shapes are parsed defensively; unknown-shaped lines
are reported as unclassified instead of silently dropped.
"""

import ast
import re
from typing import Optional

from e2e.compare import DEFAULT_TEXT_THRESHOLD, _sim, _strip_list_marker

EXTRA_PENALTY = 0.5
# Top-level fields doc_fidelity scores (ISSUES.md F7). All are outside the
# recognition/stability universe by design.
DOC_FIDELITY_FIELDS = ("entry_type", "date", "time", "clinic", "provider", "title", "notes")

_BM_PREFIX = "biomarker "
_MISS_SUFFIX = ": MISSING in observed output"
_UNEXPECTED_SUFFIX = ": UNEXPECTED in observed output (not in golden)"
_COUNT_MISMATCH_RE = re.compile(r"^(visit_data\.(?:prescriptions|recommendations)): count mismatch "
                                r"golden=(\d+) observed=(\d+)$")
_VISIT_FIELD_RE = re.compile(r"^visit_data\.(diagnosis|chief_complaint|objective_findings)\b")
_RX_INDEX_RE = re.compile(r"^visit_data\.prescriptions\[(\d+)\]")
_REC_INDEX_RE = re.compile(r"^visit_data\.recommendations\[(\d+)\]")
_INSTR_FIELD_RE = re.compile(r"^instrumental_data\.(modality|findings|conclusion)\b")
_TOP_FIELD_RE = re.compile(r"^(entry_type|date|time|clinic|provider|title|notes): ")
# biomarker detail diffs look like: biomarker '<repr>'[i] <field>: ...
_BM_DETAIL_RE = re.compile(
    r"^biomarker\s+(?P<rep>.+?)\[\d+\]\s+(?=standard_name_en\b|definition_id\b|"
    r"standard_unit\b|scope\b|standard_value\b|reference\b)"
)
# non-indexed biomarker count mismatch: biomarker 'NAME': count mismatch golden=N observed=M
_BM_COUNT_RE = re.compile(r"^biomarker\s+(?P<rep>'.*?'|\".*?\"):\s+count mismatch")


def golden_items(golden: dict) -> set[str]:
    """Comparable golden item ids (see module docstring)."""
    items: set[str] = set()
    for b in golden.get("biomarkers", []) or []:
        name = (b.get("raw_name") or "").strip()
        if name:
            items.add(f"bm:{name}")
    visit = golden.get("visit_data") or {}
    if isinstance(visit, dict):
        for f in ("diagnosis", "chief_complaint", "objective_findings"):
            v = visit.get(f) or {}
            if isinstance(v, dict):
                text = _norm(v.get("original"))
                if text:
                    items.add(f"visit:{f}")
            elif _norm(str(v or "")):
                items.add(f"visit:{f}")
        for i in range(len(visit.get("prescriptions") or [])):
            items.add(f"visit:rx:{i}")
        for i in range(len(visit.get("recommendations") or [])):
            items.add(f"visit:rec:{i}")
    instr = golden.get("instrumental_data") or {}
    if isinstance(instr, dict):
        for f in ("modality", "findings", "conclusion"):
            if _norm(str(instr.get(f) or "")):
                items.add(f"instr:{f}")
    return items


def _norm(s) -> str:
    return " ".join((s or "").split())


def _safe_repr_name(rep: str) -> Optional[str]:
    """Decode the repr() of a raw_name embedded in a diff line."""
    rep = rep.strip()
    try:
        decoded = ast.literal_eval(rep)
        return decoded if isinstance(decoded, str) else None
    except (ValueError, SyntaxError):
        return None


class _GroupedDiffs:
    def __init__(self):
        self.bad: set[str] = set()
        self.extras = 0
        # Names behind the extras count (UNEXPECTED analytes / detail rows
        # outside the universe) so case_scores can report extras_stable.
        self.extra_items: list[str] = []
        self.top_diffs: list[str] = []
        self.unclassified: list[str] = []


def group_diffs(diffs: list[str], universe: set[str]) -> _GroupedDiffs:
    """Attribute each compare.py diff to its item id, extras, or top-level."""
    g = _GroupedDiffs()
    for d in diffs:
        d = d.strip()
        if not d:
            continue

        if d.startswith(_BM_PREFIX):
            handled = False
            if d.endswith(_MISS_SUFFIX):
                name = _safe_repr_name(d[len(_BM_PREFIX):-len(_MISS_SUFFIX)])
                if name is not None:
                    g.bad.add(f"bm:{name}")
                    handled = True
            elif d.endswith(_UNEXPECTED_SUFFIX):
                name = _safe_repr_name(d[len(_BM_PREFIX):-len(_UNEXPECTED_SUFFIX)])
                if name is not None:
                    # an unexpected analyte costs roughly half an item
                    g.extras += 1
                    g.extra_items.append(name)
                    handled = True
            else:
                m = _BM_DETAIL_RE.match(d) or _BM_COUNT_RE.match(d)
                if m is not None:
                    name = _safe_repr_name(m.group("rep"))
                    if name is not None:
                        key = f"bm:{name}"
                        if key in universe:
                            g.bad.add(key)
                        else:
                            # defensive: an observed-name typo variant not in
                            # the golden universe still means some golden row
                            # didn't match cleanly; penalty via extras only.
                            g.extras += 1
                            g.extra_items.append(name)
                        handled = True
            if handled:
                continue
            g.unclassified.append(d)
            continue

        m = _COUNT_MISMATCH_RE.match(d)
        if m is not None:
            kind = "rx" if m.group(1).endswith("prescriptions") else "rec"
            n_golden = int(m.group(2))
            # ambiguous alignment: credit none of the golden rows for this family,
            # and treat surplus observed rows as extras.
            g.bad.update(f"visit:{kind}:{i}" for i in range(n_golden))
            g.extras += abs(int(m.group(3)) - n_golden)
            continue

        m = _RX_INDEX_RE.match(d)
        if m is not None:
            g.bad.add(f"visit:rx:{m.group(1)}")
            continue

        m = _REC_INDEX_RE.match(d)
        if m is not None:
            g.bad.add(f"visit:rec:{m.group(1)}")
            continue

        m = _VISIT_FIELD_RE.match(d)
        if m is not None:
            g.bad.add(f"visit:{m.group(1)}")
            continue

        m = _INSTR_FIELD_RE.match(d)
        if m is not None:
            g.bad.add(f"instr:{m.group(1)}")
            continue

        m = _TOP_FIELD_RE.match(d)
        if m is not None:
            g.top_diffs.append(d)
            continue

        g.unclassified.append(d)
    return g


def doc_fidelity_for_run(golden: dict, observed: dict,
                         threshold: float = DEFAULT_TEXT_THRESHOLD) -> tuple[float, dict[str, bool]]:
    """Top-level document fidelity of ONE run (ISSUES.md F7).

    Scores every top-level field the golden populates: entry_type/date/time by
    normalized equality (time is scored even when the extraction omits it —
    that omission is exactly the documented time-drop this co-metric exists to
    expose), clinic/provider/title/notes by comparator similarity with
    ``<field>_alt`` alternatives. A field the golden leaves empty is not
    scored, so fidelity is 1.0 for a document with no top-level metadata.
    """
    golden = golden or {}
    observed = observed or {}
    fields: dict[str, bool] = {}
    for f in DOC_FIDELITY_FIELDS:
        g = golden.get(f)
        if not _norm(str(g or "")):
            continue
        o = observed.get(f)
        if f in ("entry_type", "date", "time"):
            # A dropped observed value is a miss: fidelity, unlike the
            # comparator, does not tolerate omission.
            fields[f] = bool(_norm(str(o or ""))) and _norm(str(o or "")) == _norm(str(g or ""))
            continue
        candidates = [str(g)] + [
            a for a in (golden.get(f"{f}_alt") or []) if isinstance(a, str)
        ]
        oo = _strip_list_marker(str(o or ""))
        fields[f] = bool(_norm(oo)) and max(_sim(oo, c) for c in candidates) >= threshold
    score = sum(fields.values()) / len(fields) if fields else 1.0
    return score, fields


def recognition_for_run(universe: set[str], diffs: list[str]) -> tuple[float, _GroupedDiffs]:
    """Recognition fraction of ONE run's diffs against the universe."""
    g = group_diffs(diffs, universe)
    if not universe:
        return (1.0 if g.extras == 0 else max(0.0, 1.0 - EXTRA_PENALTY * g.extras)), g
    bad_in_universe = g.bad & universe
    ok = len(universe) - len(bad_in_universe)
    score = (ok - EXTRA_PENALTY * g.extras) / len(universe)
    return max(0.0, min(1.0, score)), g


def case_scores(golden: dict, runs_diffs: list[list[str]]) -> dict:
    """Per-case scores from N runs' diff lists."""
    universe = golden_items(golden)
    recs: list[float] = []
    ok_sets: list[set[str]] = []
    grouped: list[_GroupedDiffs] = []
    for diffs in runs_diffs:
        rec, g = recognition_for_run(universe, diffs)
        recs.append(rec)
        grouped.append(g)
        ok_sets.append(universe - (g.bad & universe))
    stable_items = set.intersection(*ok_sets) if ok_sets else set()
    if universe:
        stability = len(stable_items) / len(universe)
    else:
        stability = 1.0 if all(r >= 1.0 for r in recs) else 0.0
    extra_sets = [set(g.extra_items) for g in grouped]
    stable_extras = set.intersection(*extra_sets) if extra_sets else set()
    return {
        "universe_size": len(universe),
        "recognition": sum(recs) / len(recs) if recs else 0.0,
        "stability": max(0.0, min(1.0, stability)),
        "extras_total": sum(g.extras for g in grouped),
        "extras_stable": len(stable_extras),
        "stable_extra_items": sorted(stable_extras),
        "top_diffs": [t for g in grouped for t in g.top_diffs],
        "unclassified": [u for g in grouped for u in g.unclassified],
        "unstable_items": sorted(universe - stable_items),
        "per_run_recognition": recs,
    }


def aggregate(case_results: dict[str, dict]) -> dict:
    """Aggregate per-case scores into the loop-level metrics."""
    if not case_results:
        return {"recognition": 0.0, "stability": 0.0, "primary": 0.0}
    recognition = sum(r["recognition"] for r in case_results.values()) / len(case_results)
    stability = sum(r["stability"] for r in case_results.values()) / len(case_results)
    return {
        "recognition": round(recognition, 4),
        "stability": round(stability, 4),
        "primary": round(recognition * stability, 4),
    }
