"""
Non-destructive migration:
  1. Add the `common_rank` column to biomarker_definitions if missing.
  2. For every GLOBAL definition, recompute a concise display name (from LOINC
     COMPONENT), refresh synonyms, and populate common_rank from the LOINC CSV.

Preserves patient data, user-created (local) definitions, and any curated
reference ranges/units already stored on global definitions.

Usage:
    python -m app.db.migrate_short_names [--dry-run]
"""

import csv
import json
import logging
import os
import sys

from sqlalchemy import inspect, text

from app.db.session import SessionLocal, engine
from app.db import models  # noqa: F401
from app.db.seed_loinc import LOINC_CSV, row_to_definition

logger = logging.getLogger(__name__)


def _ensure_common_rank_column() -> None:
    insp = inspect(engine)
    cols = {c["name"] for c in insp.get_columns("biomarker_definitions")}
    if "common_rank" not in cols:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE biomarker_definitions ADD COLUMN common_rank INTEGER"))
        logger.info("Added common_rank column")
    else:
        logger.info("common_rank column already present")


def _load_csv_by_code(path: str) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    with open(path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            code = (row.get("LOINC_NUM") or "").strip()
            if code:
                rows[code] = row
    return rows


def migrate(dry_run: bool = False) -> tuple[int, int]:
    _ensure_common_rank_column()

    csv_path = os.path.abspath(LOINC_CSV)
    if not os.path.isfile(csv_path):
        logger.error("LOINC CSV not found at %s", csv_path)
        sys.exit(1)
    by_code = _load_csv_by_code(csv_path)

    db = SessionLocal()
    updated = 0
    missing = 0
    multilang_added = 0
    try:
        globals_ = db.query(models.BiomarkerDefinition).filter(
            models.BiomarkerDefinition.scope == "global"
        ).all()
        for defn in globals_:
            row = by_code.get(defn.loinc_code or defn.id)
            if not row:
                missing += 1
                continue
            new = row_to_definition(row)
            defn.names = new["names"]
            defn.synonyms = new["synonyms"]
            defn.common_rank = new["common_rank"]
            # Deliberately do NOT touch range_min/range_max/unit/range_source
            # to preserve curated values.
            updated += 1

        # Attach curated multilingual names as synonyms on the matching global
        # definitions (deterministic, no LLM needed for common localized names).
        multilang = _load_multilingual_lookup()
        by_loinc = {d.loinc_code: d for d in globals_ if d.loinc_code}
        for code, names in multilang.items():
            defn = by_loinc.get(code)
            if not defn:
                continue
            syns = set(s.lower() for s in (defn.synonyms or []))
            for n in names:
                n = n.strip()
                if n and n.lower() not in syns:
                    syns.add(n.lower())
                    defn.synonyms = (defn.synonyms or []) + [n]
                    multilang_added += 1

        if not dry_run:
            db.commit()
    finally:
        db.close()

    logger.info("Migration done: %d updated, %d without CSV match, %d multilingual synonyms",
                updated, missing, multilang_added)
    return updated, missing


def _load_multilingual_lookup() -> dict[str, list[str]]:
    path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "data", "multilingual_synonyms.json")
    )
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    by_code: dict[str, list[str]] = {}
    for _lang, mapping in data.items():
        for name, code in mapping.items():
            by_code.setdefault(code, []).append(name)
    return by_code


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Apply short display names + common_rank")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    migrate(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
