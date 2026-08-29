"""One-time migration: land log-scale canonical units on the linear scale.

Definitions anchored from a "lg копий/мл"-style document carry
canonical_unit "lg copies/mL" (canonical_kind "log10"). The matcher now
linearizes at anchor time (``definitions._linearized_anchor``); this script
brings EXISTING defs and their readings onto the same convention:

- def: canonical_unit -> the stripped linear magnitude ("copies/mL"),
  canonical_kind "linear"; the stored interval reference bounds are scaled
  (10^x for log10, exp(x) for ln). Ratio-like analytes (ratio / index /
  соотно­шение names) become dimensionless "ratio" with values and
  references untouched.
- readings: numeric values scaled (10^x, 0 stays 0), interval reference
  bounds scaled, ``scale_function`` stamped, ``status`` recomputed against
  the migrated reference.

Usage (from backend/):  venv/bin/python scripts/migrate_lg_to_linear.py
Add --dry-run to print the report without committing. A timestamped backup
of the sqlite file is written before any write (file-backed DBs only).
"""
# ruff: noqa: E402 -- load_dotenv() must run before importing app.db.session,
# which reads DATABASE_URL from the environment at import time.
import os
import shutil
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv()

from sqlalchemy.orm import Session

from app.db.models import BiomarkerDefinition as BM
from app.db.models import BiomarkerReading as BR
from app.db.session import SessionLocal
from app.services.matcher.definitions import (
    _LOG_PREFIX_RE,
    _linearized_anchor,
    _rescale_reference,
    _rescale_value,
)
from app.services.matcher.units_guess import _is_ratio_name
from app.services.reference import compute_status


def _migrate_def(defn: BM):
    """Plan the def's migration, or None when it needs no change.

    Returns ``{"unit": …, "scale_fn": …, "scale_values": bool}``.
    """
    kind = (defn.canonical_kind or "").strip().lower()
    unit = (defn.canonical_unit or "").strip()
    if kind not in ("log10", "ln") and not _LOG_PREFIX_RE.match(unit):
        return None
    eff_kind = kind if kind in ("log10", "ln") else (
        "ln" if unit.lower().startswith("ln") else "log10"
    )
    names = [defn.names.get("en") or "", *(defn.synonyms or [])]
    if isinstance(defn.reference, dict) and defn.reference.get("kind") == "qualitative":
        # Qualitative screens have no physical unit (mirrors the anchor-time
        # _is_qualitative_result rule); a lg unit here is a legacy artifact.
        return {"unit": "", "scale_fn": None, "scale_values": False}
    if _is_ratio_name(*names):
        return {"unit": "ratio", "scale_fn": None, "scale_values": False}
    trans, sf = _linearized_anchor(
        {"unit": unit, "kind": eff_kind, "inferred": False}, *names
    )
    if not sf:
        return None
    return {"unit": trans["unit"], "scale_fn": sf, "scale_values": True}


def migrate_log_anchored_defs(db: Session, dry_run: bool = False) -> dict:
    """Convert every log-anchored definition (+ its readings) to the linear
    convention. Commits unless ``dry_run``. Returns a summary report."""
    report: dict = {"defs": 0, "readings": 0, "details": []}
    for defn in db.query(BM).all():
        change = _migrate_def(defn)
        if not change:
            continue
        sf = change["scale_fn"]
        if change["scale_values"] and isinstance(defn.reference, dict):
            defn.reference = _rescale_reference(defn.reference, sf)
        defn.canonical_unit = change["unit"]
        defn.canonical_kind = "linear"
        report["defs"] += 1
        detail = {
            "def": defn.id,
            "name": defn.names.get("en"),
            "unit": change["unit"],
            "readings": 0,
        }
        for r in db.query(BR).filter(BR.biomarker_id == defn.id).all():
            changed = False
            if change["scale_values"]:
                if isinstance(r.value, (int, float)) and not isinstance(r.value, bool):
                    nv = _rescale_value(r.value, sf)
                    if nv != r.value:
                        r.value = nv
                        changed = True
                if isinstance(r.reference, dict):
                    nr = _rescale_reference(r.reference, sf)
                    if nr != r.reference:
                        r.reference = nr
                        changed = True
                if changed:
                    r.scale_function = sf
            status_val = r.value if r.value is not None else r.value_text
            new_status = compute_status(status_val, r.reference)
            if new_status != r.status:
                r.status = new_status
                changed = True
            if changed:
                report["readings"] += 1
                detail["readings"] += 1
        report["details"].append(detail)
    if not dry_run:
        db.commit()
    return report


def _sqlite_path_from_url(url: str) -> str:
    if url.startswith("sqlite:///"):
        return url[len("sqlite:///"):]
    return ""


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    from app.db.session import DATABASE_URL

    if not dry_run:
        path = os.path.abspath(_sqlite_path_from_url(DATABASE_URL))
        if path and os.path.isfile(path):
            backup = f"{path}.bak-lg-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
            shutil.copy2(path, backup)
            print(f"[backup] {backup}")

    db = SessionLocal()
    try:
        report = migrate_log_anchored_defs(db, dry_run=dry_run)
        mode = "DRY-RUN" if dry_run else "migrated"
        print(f"[{mode}] defs: {report['defs']}, readings: {report['readings']}")
        for d in report["details"]:
            print(f"  - {d['def']} ({d['name']}): unit -> {d['unit']!r}, "
                  f"readings changed: {d['readings']}")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
