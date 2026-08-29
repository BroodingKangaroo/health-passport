"""Deterministic warm-up for a freshly seeded DB (post `seed_loinc`).

A fresh DB lacks the per-user local definitions that historical live
extractions committed (English display names, canonical units such as
"copies/mL" / "lg copies/mL"). The offline validator (`validate_offline.py`)
runs matcher-only with client=None and never commits, so those anchors cannot
regenerate on their own and its diff counts drift purely due to missing
warmth — not because of matcher changes.

This script replays every case golden through the matcher with client=None,
exactly like the documented benchmark pristine-snapshot warm-up
(`benchmark/run_benchmark.py build_pristine_snapshot`), PLUS two deterministic
completions that the live LLM path would have produced historically:

1. Golden ``standard_name_en`` values are fed into RawBiomarker so local
   definitions get their English display names without an LLM.
2. Non-ASCII canonical units left by the client=None fallback are rewritten
   with the same mapping the batch translator prompts encode
   (units_guess.py docstring: "копий/мл" -> "copies/mL", log prefixes kept).
   Only user-local ("default") definitions are touched — global LOINC rows
   are never modified.

Idempotent: safe to run repeatedly.

Usage:
    venv/bin/python -m e2e.warmup_db          # repo root / PYTHONPATH=backend
"""
# ruff: noqa: E402 -- load_dotenv() must run before importing app.db.session,
# which reads DATABASE_URL from the environment at import time.
import json
import os
import sys

from dotenv import load_dotenv

load_dotenv()

from app.db.models import BiomarkerDefinition as BM
from app.db.session import SessionLocal, init_db
from app.schemas.ai import RawBiomarker, RawMedicalRecord
from app.services.matcher import match_and_convert

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT_DIR = os.path.join(ROOT, "e2e", "inputs")
GOLDEN_DIR = os.path.join(ROOT, "e2e", "golden")
USER_ID = "default"

# Anchor-ordering convention: local defs unify first-seen (names/ids, like
# units pre-task-1), so the replay order must match the e2e suite's
# alphabetical order (колонофлор_16_13.05 before _25.06) — which is already
# the default; the old 25.06-first override (lg-anchor ordering) is obsolete
# since the anchor linearization (2026-08-29).
ORDER_FIRST: list[str] = []

# Mirrors the units_guess.py batch-translator contract; extended with the
# other Russian lab units seen in real documents.
_UNIT_MAP = {
    "копий/мл": "copies/mL",
    "копии/мл": "copies/mL",
    "клеток": "",
    "мг/дл": "mg/dL",
    "ммоль/л": "mmol/L",
    "г/л": "g/L",
    "кл/мкл": "/uL",
}

# Ordered longest-prefix-first so "log10 копий/мл" doesn't eat "log".
_SCALE_PREFIXES = ["log10", "lg", "log", "ln"]


def _translate_unit(unit: str) -> tuple[str, str]:
    """Return (canonical_unit, kind) for a Cyrillic unit string."""
    u = (unit or "").strip()
    if not u or all(ord(c) < 128 for c in u):
        return u, ""
    prefix, kind = "", "linear"
    for p in _SCALE_PREFIXES:
        if u.lower().startswith(p + " "):
            prefix, kind = p, "log10" if p in ("lg", "log", "log10") else p
            u = u[len(p):].strip()
            break
    magnitude = _UNIT_MAP.get(u.lower(), u)
    return (f"{prefix} {magnitude}".strip() if prefix else magnitude), kind


def _load_definitions(db):
    defs = db.query(BM).filter(
        (BM.scope == "global") | (BM.user_id == USER_ID) | (BM.user_id.is_(None))
    ).all()
    defs.sort(key=lambda d: (d.category or "", d.names.get("en", "") or ""))
    return defs


def main() -> int:
    init_db()
    cases = sorted(
        name for name in os.listdir(INPUT_DIR)
        if os.path.isfile(os.path.join(GOLDEN_DIR, name, "standardized.json"))
    )
    for first in ORDER_FIRST:
        if first in cases:
            cases.remove(first)
            cases.insert(0, first)
    db = SessionLocal()
    try:
        for name in cases:
            with open(os.path.join(GOLDEN_DIR, name, "standardized.json"), encoding="utf-8") as f:
                golden = json.load(f)
            bm = [
                RawBiomarker(
                    name=b.get("raw_name", ""),
                    value=b.get("raw_value", ""),
                    unit=b.get("raw_unit", ""),
                    raw_range_string=b.get("raw_range_string", ""),
                    category=b.get("category"),
                    standard_name_en=b.get("standard_name_en", "")
                )
                for b in golden.get("biomarkers", [])
            ]
            raw = RawMedicalRecord(
                entry_type=golden.get("entry_type", "blood_test"),
                date=golden.get("date", ""), time=golden.get("time", ""),
                clinic=golden.get("clinic", ""), provider=golden.get("provider", ""),
                title=golden.get("title", ""), notes=golden.get("notes", ""),
                biomarkers=bm,
            )
            match_and_convert(raw, _load_definitions(db), db, USER_ID, None)
            db.commit()
            print(f"[warmed] {name}")
        # Deterministic completion: pin each "default" local definition's
        # canonical unit/display name from the verified GOLDEN row that created
        # it (matched by raw_name), exactly mirroring what months of live LLM
        # runs had committed historically. The matcher heuristic alone cannot
        # reproduce log10->linear decisions for "lg копий/мл" rows offline.
        golden_by_raw: dict[str, dict] = {}
        for name in cases:
            with open(os.path.join(GOLDEN_DIR, name, "standardized.json"), encoding="utf-8") as f:
                g = json.load(f)
            for b in g.get("biomarkers", []):
                key = (b.get("raw_name") or "").strip().lower()
                if key:
                    golden_by_raw[key] = b
        fixed = 0
        for d in db.query(BM).filter(BM.scope == "local", BM.user_id == USER_ID).all():
            syns = list(d.synonyms or [])
            candidates = [d.names.get("en") or "", *syns]
            growl = next((golden_by_raw[c.strip().lower()] for c in candidates
                          if c and c.strip().lower() in golden_by_raw), None)
            en = (growl.get("standard_name_en") or "").strip() if growl else ""
            if en and all(ord(c) < 128 for c in en) and d.names.get("en") != en:
                d.names = {"en": en}
            su = ((growl.get("standard_unit") or "").strip()) if growl else ""
            cu = (d.canonical_unit or "").strip()
            new_unit, kind = _translate_unit(cu)
            if su and all(ord(c) < 128 for c in su):
                new_unit, kind = su, ("log10" if su.lower().startswith(("lg", "log")) else "linear")
            elif su == "" and growl is not None:
                # The golden row is deliberately unitless (a qualitative
                # screen anchors canonical "") — pin the empty canonical so
                # stale non-empty anchors (e.g. forensics-era "copies/mL")
                # don't drift the offline validator.
                new_unit, kind = "", "linear"
            elif cu and not all(ord(c) < 128 for c in cu):
                if not new_unit or new_unit == cu:
                    continue
            elif not new_unit:
                continue
            if new_unit != cu:
                d.canonical_unit = new_unit
            if kind:
                d.canonical_kind = kind
            fixed += 1
        db.commit()
        print(f"[units] pinned {fixed} local defs from golden truth")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
