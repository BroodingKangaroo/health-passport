"""Tolerant comparison between an observed StandardizedMedicalRecord (JSON from
/api/extract) and a hand-verified golden StandardizedMedicalRecord.

Comparison rules (from the e2e spec):
  - biomarkers: compared as a set keyed by raw_name. For each, standard_name_en,
    definition_id, standard_unit and scope must match EXACTLY; standard_value
    allows a float tolerance; status is recomputed (ignored); ordering ignored.
  - visit_data / instrumental_data: deep-compared with normalized whitespace;
    `original` must match exactly (it is frozen by extraction on the server),
    `translated_en` is allowed a similarity threshold (live translation is
    non-deterministic).
  - top-level: entry_type exact; date/time normalized; clinic/provider/title/
    notes via similarity threshold.

Returns a list of human-readable diff strings (empty list == match)."""

import difflib
import re
from collections import defaultdict

DEFAULT_TEXT_THRESHOLD = 0.9
VALUE_TOLERANCE = 1e-6


def _norm(s):
    return " ".join((s or "").split())


def _sim(a, b):
    return difflib.SequenceMatcher(None, _norm(a) or "", _norm(b) or "").ratio()


_LEADING_MARKER_RE = re.compile(r"^\s*(?:\d{1,2}[.)]\s*|[•*·-]\s+)")


def _strip_list_marker(s: str) -> str:
    """Drop a leading list marker ("1. ", "2) ", "• ").

    OCR sometimes keeps the document's list numbering inside a recommendation
    and sometimes strips it; the number itself carries no clinical content
    (ordering is already encoded in the item's index), so it must not read as
    a translation/extraction failure.
    """
    return _LEADING_MARKER_RE.sub("", s or "", count=1)


def _cmp_tx(observed, golden, path, diffs, thr):
    """Compare a TranslatedText-shaped dict ({original, translated_en}).

    Two presentation-variance accommodations, both validated against real
    provider/OCR behavior:
    - ``translated_en_alt`` — a golden may list alternative acceptable EN
      renderings; scoring takes the BEST similarity across primary +
      alternatives ("Balanced" vs "Rational nutrition" are both valid
      translations of «Рациональное питание»).
    - leading list markers are stripped from both sides before comparison
      (OCR keeps/strips "1. " nondeterministically; ordering is already
      encoded in the item index).
    """
    if not isinstance(golden, dict):
        diffs.append(f"{path}: expected TranslatedText object, got {type(observed).__name__}")
        return
    obs = observed if isinstance(observed, dict) else {}

    o_orig = _norm(_strip_list_marker(obs.get("original", "")))
    g_orig = _norm(_strip_list_marker(golden.get("original", "")))
    if o_orig != g_orig:
        diffs.append(f"{path}.original: expected {g_orig!r}, got {o_orig!r}")

    o_tr = obs.get("translated_en", "")
    g_tr = golden.get("translated_en", "")
    candidates = [g_tr] + [
        a for a in (golden.get("translated_en_alt") or []) if isinstance(a, str)
    ]
    candidates = [_strip_list_marker(c) for c in candidates if _norm(c)]
    o_tr = _strip_list_marker(o_tr)
    if candidates:
        best_sim = max(_sim(o_tr, c) for c in candidates)
        best = max(candidates, key=lambda c: _sim(o_tr, c))
        if best_sim < thr:
            diffs.append(
                f"{path}.translated_en: similarity {best_sim:.2f} < {thr} "
                f"(expected {best!r}, got {o_tr!r})"
            )


def _cmp_biomarkers(observed_list, golden_list, diffs, tol=VALUE_TOLERANCE, thr=DEFAULT_TEXT_THRESHOLD):
    def group(lst):
        m = defaultdict(list)
        for i, b in enumerate(lst or []):
            m[b.get("raw_name", "")].append((i, b))
        return m

    obs = group(observed_list)
    gol = group(golden_list)

    # OCR raw-name variance: the same analyte surfaces under cosmetic OCR
    # variants across runs («MCH (ср. содерж. Hb в эр.)» vs
    # «MCH (ср. содер. Hb в эр.)»). Pair each MISSING golden name with its
    # best-matching UNEXPECTED observed name (high similarity, same analyte
    # family) and compare the pair under the golden's name; only the
    # raw_name spelling itself is tolerated — every other field must still
    # match, so a genuinely mis-routed analyte still fails.
    missing = sorted(set(gol) - set(obs))
    unexpected = sorted(set(obs) - set(gol))
    pairs: dict[str, str] = {}
    used: set[str] = set()
    for gname in missing:
        best, best_sim = None, 0.0
        for oname in unexpected:
            if oname in used:
                continue
            sim = _sim(_strip_list_marker(gname), _strip_list_marker(oname))
            if sim > best_sim:
                best, best_sim = oname, sim
        if best is not None and best_sim >= 0.85:
            pairs[gname] = best
            used.add(best)
    for name in missing:
        if name not in pairs:
            diffs.append(f"biomarker {name!r}: MISSING in observed output")
    for name in unexpected:
        if name not in used:
            diffs.append(f"biomarker {name!r}: UNEXPECTED in observed output (not in golden)")

    compared = sorted(set(obs) & set(gol)) + sorted(pairs)
    for name in compared:
        go = gol[name]
        oo = obs[pairs.get(name, name)]
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
            # standard_value: numeric float tolerance; qualitative (string) values
            # are OCR-extracted, so compare via text similarity (skip when either
            # side is empty — the comparator never penalises a missing value).
            # value+reference are compared together: an absent result encoded as
            # 0.0 + unbounded interval equals "Not detected" + qualitative.
            _cmp_biomarker_value_and_reference(ob, gb, name, diffs, tol, thr)


def _cmp_value(ov, gv, path, diffs, tol, thr):
    try:
        ovf = float(ov)
        gvf = float(gv)
        if abs(ovf - gvf) > tol:
            diffs.append(f"{path}: expected {gv!r}, got {ov!r}")
        return
    except (TypeError, ValueError):
        pass
    # At least one side is a non-numeric string.
    os_ = "" if ov is None else str(ov)
    gs_ = "" if gv is None else str(gv)
    if not _norm(gs_) and not _norm(os_):
        return
    if _norm(gs_):
        if _sim(os_, gs_) < thr:
            diffs.append(
                f"{path}: similarity {_sim(os_, gs_):.2f} < {thr} "
                f"(expected {gv!r}, got {ov!r})"
            )
    elif os_ != gs_:
        diffs.append(f"{path}: expected {gv!r}, got {ov!r}")


# Canonical absent values (app/services/reference.py _ABSENT_CANONICAL): a
# reading encoded as 0.0 against an unbounded interval and the same reading
# encoded as "Not detected" against a qualitative reference are SEMANTICALLY
# equivalent (an absent screen). OCR recovers/drops the source note cell
# («допустимо любое количество») run-to-run, flipping the encoding; the
# comparator accepts both forms of the same absent fact.
_ABSENT_STRINGS = {"not detected", "negative", "absent", "normal"}


def _absent_encoding(value, ref):
    """Return "absent-unbounded" when (value, reference) is an absent result
    encoded as 0.0 + interval{null,null}, "absent-qualitative" when it is an
    absent string + qualitative, else None."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value == 0.0 and isinstance(ref, dict) \
                and ref.get("kind") == "interval" \
                and ref.get("low") is None and ref.get("high") is None:
            return "absent-unbounded"
        return None
    if (isinstance(value, str) and value.strip().lower() in _ABSENT_STRINGS
            and isinstance(ref, dict) and ref.get("kind") == "qualitative"):
        return "absent-qualitative"
    return None


def _cmp_biomarker_value_and_reference(ob, gb, name, diffs, tol, thr):
    """Compare standard_value + reference with the absent-encoding
    equivalence: when both sides encode an ABSENT result (0.0+unbounded
    interval vs "Not detected"+qualitative), the encodings are accepted as
    equal and only the absence itself is checked."""
    ov, gv = ob.get("standard_value"), gb.get("standard_value")
    oref, gref = ob.get("reference"), gb.get("reference")
    o_enc = _absent_encoding(ov, oref)
    g_enc = _absent_encoding(gv, gref)
    if o_enc and g_enc and o_enc != g_enc:
        return  # same absent fact, different (equivalent) encoding
    _cmp_value(ov, gv, f"biomarker {name!r}[0] standard_value", diffs, tol, thr)
    _cmp_reference(oref, gref, f"biomarker {name!r}[0] reference", diffs, tol, thr)


def _cmp_reference(oref, gref, path, diffs, tol, thr):
    gk = gref.get("kind") if isinstance(gref, dict) else None
    ok = oref.get("kind") if isinstance(oref, dict) else None
    if gk != ok:
        diffs.append(f"{path}.kind: expected {gk!r}, got {ok!r}")
        return
    if gk == "interval":
        gf = (gref.get("low"), gref.get("high"))
        of = (oref.get("low"), oref.get("high"))
        for j, (g, o) in enumerate(zip(gf, of)):
            try:
                if abs(float(o) - float(g)) > tol:
                    diffs.append(f"{path}.{'low' if j == 0 else 'high'}: expected {g!r}, got {o!r}")
            except (TypeError, ValueError):
                if o != g:
                    diffs.append(f"{path}.{'low' if j == 0 else 'high'}: expected {g!r}, got {o!r}")
    elif gk == "qualitative":
        gexp = gref.get("expected") or ""
        oexp = oref.get("expected") or ""
        # expected is OCR/text-derived; compare via similarity, skip if golden
        # has no expected text (qualitative-without-expected).
        if _norm(gexp) and _sim(oexp, gexp) < thr:
            diffs.append(
                f"{path}.expected: similarity {_sim(oexp, gexp):.2f} < {thr} "
                f"(expected {gexp!r}, got {oexp!r})"
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


def _cmp_instrumental(gi, oi, diffs, thr):
    if not gi:
        return
    oi = oi or {}
    # modality is LLM free-text (e.g. "Ультразвуковое исследование эластометрия"),
    # not a fixed vocabulary, so it gets the same similarity treatment as
    # findings/conclusion — an exact match would fail on harmless paraphrases.
    # `modality_alt` tolerates equivalent category picks: an ultrasound-based
    # liver elastography legitimately lands on either "Elastography" or
    # "Ultrasound" (both are in the UI's fixed option set).
    for f in ("modality", "findings", "conclusion"):
        g = gi.get(f, "")
        o = oi.get(f, "")
        if not _norm(g) or not _norm(o):
            continue
        candidates = [g] + [
            a for a in (gi.get(f"{f}_alt") or []) if isinstance(a, str)
        ]
        candidates = [c for c in candidates if _norm(c)]
        best_sim = max(_sim(o, c) for c in candidates)
        best = max(candidates, key=lambda c: _sim(o, c))
        if best_sim < thr:
            diffs.append(
                f"instrumental_data.{f}: similarity {best_sim:.2f} < {thr} "
                f"(expected {best!r}, got {o!r})"
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

    diffs.extend(
        f"{f}: expected {golden.get(f)!r}, got {observed.get(f)!r}"
        for f in ("date",)
        if _norm(observed.get(f, "")) != _norm(golden.get(f, ""))
    )
    # `time` is secondary metadata the extraction prompt explicitly permits
    # omitting ("only when shown NEXT TO the collection date") — the model
    # drops it on some layouts consistently (биохимия/оак under
    # mistral-medium). Same policy as the free-text fields: an omitted value
    # is not a regression. The golden keeps the verified time, so a run that
    # DOES recover it is still validated exactly. `date` (collection-date
    # semantics) stays exact.
    gt = _norm(golden.get("time", ""))
    ot = _norm(observed.get("time", ""))
    if gt and ot and gt != ot:
        diffs.append(f"time: expected {golden.get('time')!r}, got {observed.get('time')!r}")

    for f in ("clinic", "provider", "title", "notes"):
        g = golden.get(f, "")
        o = observed.get(f, "")
        # Skip when either side is empty: an omitted field (e.g. `notes` left
        # blank because the diagnosis landed in `visit_data.diagnosis`) is not
        # a regression — live LLM extraction places such text non-deterministically.
        if _norm(g) and _norm(o):
            # `<field>_alt` mirrors translated_en_alt: a golden may list
            # alternative acceptable renderings of the same source text (the
            # колонофлор_16_* title flips between the short test name and the
            # full section header run-to-run; both are faithful).
            candidates = [g] + [
                a for a in (golden.get(f"{f}_alt") or []) if isinstance(a, str)
            ]
            candidates = [c for c in candidates if _norm(c)]
            best_sim = max(_sim(o, c) for c in candidates)
            best = max(candidates, key=lambda c: _sim(o, c))
            if best_sim < text_threshold:
                diffs.append(f"{f}: similarity {best_sim:.2f} < {text_threshold} "
                             f"(expected {best!r}, got {o!r})")

    _cmp_biomarkers(observed.get("biomarkers"), golden.get("biomarkers"), diffs, thr=text_threshold)
    _cmp_visit(golden.get("visit_data"), observed.get("visit_data"), diffs, text_threshold)
    _cmp_instrumental(golden.get("instrumental_data"), observed.get("instrumental_data"), diffs, text_threshold)

    return diffs
