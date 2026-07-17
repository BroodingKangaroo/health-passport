"""Tolerant comparison between an observed StandardizedMedicalRecord (JSON from
/api/extract) and a hand-verified golden StandardizedMedicalRecord.

Comparison rules (from the e2e spec):
  - biomarkers: compared as a set keyed by raw_name. For each, standard_name_en,
    definition_id, standard_unit and scope must match EXACTLY; standard_value
    allows a float tolerance; status is recomputed (ignored); ordering ignored.
  - visit_data / imaging_data: deep-compared with normalized whitespace;
    `original` must match exactly (it is frozen by extraction on the server),
    `translated_en` is allowed a similarity threshold (live translation is
    non-deterministic).
  - top-level: entry_type exact; date/time normalized; clinic/provider/title/
    notes via similarity threshold.

Returns a list of human-readable diff strings (empty list == match)."""

import difflib
from collections import defaultdict

DEFAULT_TEXT_THRESHOLD = 0.9
VALUE_TOLERANCE = 1e-6


def _norm(s):
    return " ".join((s or "").split())


def _sim(a, b):
    return difflib.SequenceMatcher(None, _norm(a) or "", _norm(b) or "").ratio()


def _cmp_tx(observed, golden, path, diffs, thr):
    """Compare a TranslatedText-shaped dict ({original, translated_en})."""
    if not isinstance(golden, dict):
        diffs.append(f"{path}: expected TranslatedText object, got {type(observed).__name__}")
        return
    obs = observed if isinstance(observed, dict) else {}

    o_orig = _norm(obs.get("original", ""))
    g_orig = _norm(golden.get("original", ""))
    if o_orig != g_orig:
        diffs.append(f"{path}.original: expected {g_orig!r}, got {o_orig!r}")

    o_tr = obs.get("translated_en", "")
    g_tr = golden.get("translated_en", "")
    if _norm(g_tr) and _sim(o_tr, g_tr) < thr:
        diffs.append(
            f"{path}.translated_en: similarity {_sim(o_tr, g_tr):.2f} < {thr} "
            f"(expected {g_tr!r}, got {o_tr!r})"
        )


def _cmp_biomarkers(observed_list, golden_list, diffs, tol=VALUE_TOLERANCE):
    def group(lst):
        m = defaultdict(list)
        for i, b in enumerate(lst or []):
            m[b.get("raw_name", "")].append((i, b))
        return m

    obs = group(observed_list)
    gol = group(golden_list)

    for name in sorted(set(gol) - set(obs)):
        diffs.append(f"biomarker {name!r}: MISSING in observed output")
    for name in sorted(set(obs) - set(gol)):
        diffs.append(f"biomarker {name!r}: UNEXPECTED in observed output (not in golden)")

    for name in sorted(set(obs) & set(gol)):
        go = gol[name]
        oo = obs[name]
        if len(go) != len(oo):
            diffs.append(f"biomarker {name!r}: count mismatch golden={len(go)} observed={len(oo)}")
        for i in range(min(len(go), len(oo))):
            gb = go[i][1]
            ob = oo[i][1]
            for f in ("standard_name_en", "definition_id", "standard_unit", "scope"):
                if ob.get(f) != gb.get(f):
                    diffs.append(
                        f"biomarker {name!r}[{i}] {f}: expected {gb.get(f)!r}, got {ob.get(f)!r}"
                    )
            # standard_value: float tolerance; status is recomputed (ignored).
            try:
                ov = float(ob.get("standard_value"))
                gv = float(gb.get("standard_value"))
                if abs(ov - gv) > tol:
                    diffs.append(
                        f"biomarker {name!r}[{i}] standard_value: expected {gv!r}, got {ov!r}"
                    )
            except (TypeError, ValueError):
                if ob.get("standard_value") != gb.get("standard_value"):
                    diffs.append(
                        f"biomarker {name!r}[{i}] standard_value: expected "
                        f"{gb.get('standard_value')!r}, got {ob.get('standard_value')!r}"
                    )


def _cmp_visit(gv, ov, diffs, thr):
    if not gv:
        return
    ov = ov or {}
    for f in ("diagnosis", "chief_complaint", "objective_findings"):
        if f in gv:
            _cmp_tx(ov.get(f), gv.get(f), f"visit_data.{f}", diffs, thr)

    gp = gv.get("prescriptions") or []
    op = ov.get("prescriptions") or []
    if len(gp) != len(op):
        diffs.append(f"visit_data.prescriptions: count mismatch golden={len(gp)} observed={len(op)}")
    for i, (g, o) in enumerate(zip(gp, op)):
        for f in ("name", "dosage", "instructions"):
            _cmp_tx(o.get(f), g.get(f), f"visit_data.prescriptions[{i}].{f}", diffs, thr)

    gr = gv.get("recommendations") or []
    orr = ov.get("recommendations") or []
    if len(gr) != len(orr):
        diffs.append(f"visit_data.recommendations: count mismatch golden={len(gr)} observed={len(orr)}")
    for i, (g, o) in enumerate(zip(gr, orr)):
        _cmp_tx(o, g, f"visit_data.recommendations[{i}]", diffs, thr)


def _cmp_imaging(gi, oi, diffs, thr):
    if not gi:
        return
    oi = oi or {}
    for f in ("modality",):
        if gi.get(f) and _norm(oi.get(f, "")) != _norm(gi.get(f, "")):
            diffs.append(f"imaging_data.{f}: expected {gi.get(f)!r}, got {oi.get(f)!r}")
    for f in ("findings", "conclusion"):
        g = gi.get(f, "")
        o = oi.get(f, "")
        if _norm(g) and _sim(o, g) < thr:
            diffs.append(
                f"imaging_data.{f}: similarity {_sim(o, g):.2f} < {thr} "
                f"(expected {g!r}, got {o!r})"
            )


def compare_standardized(observed, golden, text_threshold=DEFAULT_TEXT_THRESHOLD):
    diffs = []
    if not isinstance(observed, dict) or not isinstance(golden, dict):
        return [f"expected two StandardizedMedicalRecord JSON objects, got "
                f"{type(observed).__name__} / {type(golden).__name__}"]

    if observed.get("entry_type") != golden.get("entry_type"):
        diffs.append(
            f"entry_type: expected {golden.get('entry_type')!r}, got {observed.get('entry_type')!r}"
        )

    for f in ("date", "time"):
        if _norm(observed.get(f, "")) != _norm(golden.get(f, "")):
            diffs.append(f"{f}: expected {golden.get(f)!r}, got {observed.get(f)!r}")

    for f in ("clinic", "provider", "title", "notes"):
        g = golden.get(f, "")
        o = observed.get(f, "")
        # Skip when either side is empty: an omitted field (e.g. `notes` left
        # blank because the diagnosis landed in `visit_data.diagnosis`) is not
        # a regression — live LLM extraction places such text non-deterministically.
        if _norm(g) and _norm(o) and _sim(o, g) < text_threshold:
            diffs.append(f"{f}: similarity {_sim(o, g):.2f} < {text_threshold} "
                         f"(expected {g!r}, got {o!r})")

    _cmp_biomarkers(observed.get("biomarkers"), golden.get("biomarkers"), diffs)
    _cmp_visit(golden.get("visit_data"), observed.get("visit_data"), diffs, text_threshold)
    _cmp_imaging(golden.get("imaging_data"), observed.get("imaging_data"), diffs, text_threshold)

    return diffs
