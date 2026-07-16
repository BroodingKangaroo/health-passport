"""
Drop all tables, recreate from ORM metadata, then seed the biomarker_definitions
table from data/Loinc.csv using CLASS-based filtering for lab-relevant codes.

Usage:
    python -m app.db.seed_loinc
"""

import csv
import json
import logging
import os
import re
import sys
from typing import Optional

from app.db.session import engine, Base, SessionLocal
from app.db import models  # noqa: F401

logger = logging.getLogger(__name__)

LOINC_CSV = os.path.join(os.path.dirname(__file__), "..", "..", "data", "Loinc.csv")
LOINC_NAME_OVERRIDES_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "data", "loinc_name_overrides.json"
)


def _load_name_overrides() -> dict[str, str]:
    """LOINC code -> curated English display name (skips `_comment` keys)."""
    path = os.path.abspath(LOINC_NAME_OVERRIDES_PATH)
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return {k: v for k, v in data.items() if not k.startswith("_")}


LOINC_NAME_OVERRIDES = _load_name_overrides()

# Core lab-relevant LOINC classes
LAB_CLASSES = {
    "CHEM",       # Chemistry
    "HEM/BC",     # Hematology/Blood Counts
    "COAG",       # Coagulation
    "URINALYSIS", # Urinalysis
    "TOX",        # Toxicology
}

# Classes to explicitly exclude
EXCLUDE_CLASSES = {
    "SURVEY", "SURVEY.PNDS", "SURVEY.MTLHLTH", "SURVEY.ESRD",
    "SURVEY.CMS", "SURVEY.PHENX", "SURVEY.PUBLICHEALTH",
    "PANEL", "PANEL.CHEM", "PANEL.SURVEY.ESRD",
    "LABORDERS", "LABORDERS.ONTOLOGY",
    "H&P", "H&P.HX",
    "PHENX",
    "PUBLICHEALTH",
    "CLAIMS", "CLAIMS.ATTACH",
    "DOC", "DOC.ONTOLOGY",
    "REGSTUDY", "REGSTUDY.ONTOLOGY",
    "OH", "OH.DENTAL",
    "ATTACH", "ATTACH.CLINICAL",
    "CMS", "CMS.ASSESSMENT",
    "MOLPATH", "MOLPATH.TRNLOC", "MOLPATH.MUT",
    "MOLPATH.PHARMG", "MOLPATH.REARRANGE", "MOLPATH.DEL",
    "MOLPATH.DELDUP", "MOLPATH.NUCREPEAT", "MOLPATH.TRISOMY",
    "MOLPATH.MISC", "MOLPATH.INV",
    "CYTO", "PATH", "PATH.HISTO", "PATH.PROTOCOLS.GENER",
    "PATH.PROTOCOLS.PROST", "PATH.PROTOCOLS.SKIN", "PATH.PROTOCOLS.BRST",
    "CARD", "CARD.US", "CARD.US.DICOM", "CARD.PROC", "CARD.RISK",
    "CARDIO-PULM", "ENDO", "ENDO.GI", "ENDO.PULM", "FERT",
    "HEMODYN", "HEMODYN.MOLEC", "HEMODYN.ATOM",
    "SERO", "HEP", "IMMUNO", "MICRO", "DRUG/TOX",
}


def reset_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables dropped and recreated")


def is_lab_class(class_name: str) -> bool:
    """Check if a LOINC class is lab-relevant."""
    if not class_name:
        return False
    cls = class_name.strip().upper()
    if cls in EXCLUDE_CLASSES:
        return False
    # Check if it starts with any of our lab class prefixes
    for lab_cls in LAB_CLASSES:
        if cls.startswith(lab_cls):
            return True
    return False


def parse_loinc_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = []
        for row in reader:
            # Only keep ACTIVE status
            if row.get("STATUS", "").strip().upper() != "ACTIVE":
                continue
            # Filter by class
            if not is_lab_class(row.get("CLASS", "")):
                continue
            # Only keep codes with COMMON_TEST_RANK > 0 (commonly ordered tests)
            try:
                rank = int(row.get("COMMON_TEST_RANK", "0") or 0)
            except (ValueError, TypeError):
                rank = 0
            if rank <= 0:
                continue
            rows.append(row)
        return rows


def _sanitize(text: str) -> str:
    """Strip leading characters commonly used for CSV formula injection."""
    if not text:
        return text
    if text[0] in ("=", "@", "+", "-", "\t", "\r"):
        return text.lstrip("=@+-\t\r")
    return text


# LOINC sub-part qualifiers (after a ".") that name a distinct cell subtype.
# These must NOT be discarded — they identify clinically separate analytes
# (e.g. band vs. segmented neutrophils). We surface them as a readable prefix.
_SUBTYPE_PREFIXES = {
    "band form": "Band",
    "segmented": "Segmented",
    "hypersegmented": "Hypersegmented",
    "immature": "Immature",
    "atypical": "Atypical",
    "variant": "Variant",
    "abnormal": "Abnormal",
    "plasmacytoid": "Plasmacytoid",
    "reactive": "Reactive",
    # Distinct analytes that must NOT collapse into their parent substance.
    "nucleated": "Nucleated",
    "free": "Free",
    "ionized": "Ionized",
    "unconjugated": "Unconjugated",
    "conjugated": "Conjugated",
}


def _short_display_name(component: str) -> str:
    """Derive a concise, patient-friendly name from the LOINC COMPONENT.

    Examples:
      "Cholesterol"                     -> "Cholesterol"
      "Glucose^post CFst"               -> "Glucose"
      "Hemoglobin A1c/Hemoglobin.total" -> "Hemoglobin A1c"
      "Neutrophils.segmented"           -> "Segmented Neutrophils"
      "Neutrophils.band form/Leukocytes"-> "Band Neutrophils"
    """
    if not component:
        return component
    # Drop the "^challenge" qualifier (e.g. fasting/post-dose context).
    name = component.split("^", 1)[0].strip()
    # For ratios keep the numerator, which is the analyte of interest.
    if "/" in name:
        name = name.split("/", 1)[0].strip()
    # Handle a LOINC sub-part suffix (text after "."). Known cell subtypes are
    # preserved as a readable prefix; generic sub-parts (.total/.free/...) are
    # trimmed so common variants collapse onto one canonical name.
    if "." in name:
        base, sub = name.split(".", 1)
        base = base.strip()
        prefix = _SUBTYPE_PREFIXES.get(sub.strip().lower())
        name = f"{prefix} {base}" if prefix else base
    return name or component


def _long_name_acronym(long_name: str) -> str:
    """Leading acronym/token of a LONG_COMMON_NAME (e.g. 'MCHC [Entitic...]' -> 'MCHC')."""
    token = re.split(r"[\s\[]", long_name.strip(), 1)[0].strip()
    return token


def row_to_definition(row: dict) -> dict:
    long_name = _sanitize((row.get("LONG_COMMON_NAME") or "").strip())
    short_name = _sanitize((row.get("SHORTNAME") or "").strip())
    component = _sanitize((row.get("COMPONENT") or "").strip())
    prop = (row.get("PROPERTY") or "").strip()
    loinc_num = (row.get("LOINC_NUM") or "").strip()
    try:
        common_rank = int(row.get("COMMON_TEST_RANK", "0") or 0) or None
    except (ValueError, TypeError):
        common_rank = None

    # Entitic properties (MCH/MCHC/MCV etc.) are per-cell derived indices whose
    # COMPONENT is a generic analyte name (e.g. "Hemoglobin"). Using that bare
    # name would both mislead patients and collide with the direct measurement,
    # so name them by their acronym and do not expose the generic component.
    is_entitic = prop.startswith("Ent")
    # Number-fraction properties are the "%" form of a cell differential; keep
    # them distinct from the absolute count so both can coexist.
    is_fraction = prop == "NFr" or prop.startswith("NFr.")

    override = LOINC_NAME_OVERRIDES.get(loinc_num)
    heuristic_name = (
        _long_name_acronym(long_name) or _short_display_name(component)
        if is_entitic
        else _short_display_name(component) or long_name
    )
    if is_fraction and heuristic_name and not heuristic_name.endswith("%"):
        heuristic_name = f"{heuristic_name} %"

    # A curated override wins (e.g. ESR/Hematocrit, whose COMPONENT is the
    # substance rather than the measurement); the heuristic name is kept as a
    # synonym for recall.
    display_name = override or heuristic_name

    synonyms = []
    synonym_sources = (long_name, short_name) if is_entitic else (long_name, short_name, component)
    if override:
        synonym_sources = (heuristic_name, *synonym_sources)
    for candidate in synonym_sources:
        if candidate and candidate != display_name and candidate not in synonyms:
            synonyms.append(candidate)
    # Add RELATEDNAMES2 if present
    related = _sanitize((row.get("RELATEDNAMES2") or "").strip())
    if related:
        for r in related.split(";"):
            r = _sanitize(r.strip())
            if r and r != display_name and r not in synonyms:
                synonyms.append(r)

    return {
        "id": loinc_num,
        "loinc_code": loinc_num,
        "names": {"en": display_name},
        "synonyms": list(dict.fromkeys(synonyms)),
        "category": _sanitize((row.get("CLASS") or "General").strip()),
        "range_min": None,
        "range_max": None,
        "unit": _sanitize((row.get("EXAMPLE_UCUM_UNITS") or "").strip()),
        "scope": "global",
        "user_id": None,
        "range_source": "global",
        "common_rank": common_rank,
    }


def dedupe_definitions(definitions: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """Collapse definitions that share a display name to a single canonical entry.

    Many LOINC variants (different methods/systems/timings) reduce to the same
    concise COMPONENT-based name. We keep the most commonly ordered variant
    (lowest COMMON_TEST_RANK) and fold every dropped variant's name + synonyms
    into the survivor's synonyms so matching recall is preserved.

    Returns ``(survivors, aliases)`` where ``aliases`` maps every folded (dropped)
    LOINC code to the surviving code that absorbed it, so downstream lookups that
    reference a folded code can still resolve to the canonical definition.
    """
    from app.db.import_ranges import COMMON_RANGES
    curated_codes = set(COMMON_RANGES)

    def _sort_key(d: dict) -> tuple[int, int]:
        # Prefer variants that have a curated reference range so those ranges
        # land on the surviving canonical definition; then lowest COMMON_TEST_RANK.
        has_curated = 0 if (d.get("loinc_code") in curated_codes) else 1
        r = d.get("common_rank")
        return (has_curated, r if r is not None else 10**9)

    survivors: dict[str, dict] = {}
    for d in definitions:
        name = (d.get("names", {}).get("en") or "").strip()
        if not name:
            continue
        key = name.lower()
        current = survivors.get(key)
        if current is None or _sort_key(d) < _sort_key(current):
            survivors[key] = d

    # Second pass: merge dropped variants' names/synonyms into their survivor and
    # record folded-code -> survivor-code aliases.
    extra_synonyms: dict[str, list[str]] = {k: [] for k in survivors}
    aliases: dict[str, str] = {}
    for d in definitions:
        name = (d.get("names", {}).get("en") or "").strip()
        if not name:
            continue
        key = name.lower()
        survivor = survivors[key]
        if d is survivor:
            continue
        folded_code = d.get("loinc_code")
        survivor_code = survivor.get("loinc_code")
        if folded_code and survivor_code and folded_code != survivor_code:
            aliases[folded_code] = survivor_code
        for cand in [d.get("names", {}).get("en", "")] + list(d.get("synonyms") or []):
            cand = (cand or "").strip()
            if cand:
                extra_synonyms[key].append(cand)

    result = []
    for key, survivor in survivors.items():
        survivor_name = survivor["names"]["en"]
        merged = list(survivor.get("synonyms") or []) + extra_synonyms[key]
        seen = set()
        clean = []
        for s in merged:
            s = (s or "").strip()
            if s and s != survivor_name and s.lower() not in seen:
                seen.add(s.lower())
                clean.append(s)
        survivor["synonyms"] = clean
        result.append(survivor)
    return result, aliases


MULTILINGUAL_SYNONYMS = os.path.join(os.path.dirname(__file__), "..", "..", "data", "multilingual_synonyms.json")  # noqa: E501
LOINC_ALIASES_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "loinc_aliases.json")  # noqa: E501


def load_multilingual_synonyms() -> dict[str, list[str]]:
    """Map LOINC code -> list of localized (non-English) names.

    Source: curated data/multilingual_synonyms.json keyed by language.
    """
    path = os.path.abspath(MULTILINGUAL_SYNONYMS)
    if not os.path.isfile(path):
        logger.warning("Multilingual synonyms file not found: %s", path)
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    by_code: dict[str, list[str]] = {}
    for _lang, mapping in data.items():
        for name, code in mapping.items():
            by_code.setdefault(code, []).append(name)
    return by_code


def apply_multilingual_synonyms(
    definitions: list[dict], aliases: Optional[dict[str, str]] = None
) -> list[dict]:
    """Attach localized names as synonyms on the matching LOINC definition.

    When a curated code was deduplicated away, ``aliases`` (folded -> survivor)
    redirects its localized names onto the surviving canonical definition so the
    mapping is never silently lost.
    """
    aliases = aliases or {}
    by_code = {d.get("loinc_code"): d for d in definitions if d.get("loinc_code")}
    multilang = load_multilingual_synonyms()
    added = 0
    missing: list[str] = []
    for code, names in multilang.items():
        defn = by_code.get(code) or by_code.get(aliases.get(code, ""))
        if not defn:
            missing.append(code)
            continue
        syns = set(s.lower() for s in (defn.get("synonyms") or []))
        for n in names:
            n = n.strip()
            if n and n.lower() not in syns:
                syns.add(n.lower())
                defn["synonyms"].append(n)
                added += 1
    logger.info("Attached %d multilingual synonym names", added)
    if missing:
        logger.warning("Multilingual codes not seeded (no survivor): %s", ", ".join(sorted(missing)))
    return definitions


def seed_biomarkers(db, definitions: list[dict]):
    existing = {r.id for r in db.query(models.BiomarkerDefinition.id).all()}
    count = 0
    for d in definitions:
        if d["id"] in existing:
            continue
        db.add(models.BiomarkerDefinition(**d))
        count += 1
    db.commit()
    return count


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    csv_path = os.path.abspath(LOINC_CSV)
    if not os.path.isfile(csv_path):
        logger.error("LOINC CSV not found at %s", csv_path)
        sys.exit(1)

    print("WARNING: This will DROP ALL tables and reseed from LOINC CSV.")
    print(f"Source: {csv_path}")
    confirm = input("Type 'yes' to continue: ")
    if confirm.strip().lower() != "yes":
        print("Aborted.")
        sys.exit(0)

    logger.info("Parsing %s ...", csv_path)
    loinc_rows = parse_loinc_csv(csv_path)
    logger.info("Found %d LOINC entries with lab-relevant classes and rank > 0", len(loinc_rows))

    if not loinc_rows:
        logger.warning("No rows matched — seeding aborted.")
        sys.exit(0)

    definitions = [row_to_definition(r) for r in loinc_rows]
    before = len(definitions)
    definitions, aliases = dedupe_definitions(definitions)
    logger.info("Deduped %d -> %d definitions (by display name)", before, len(definitions))
    definitions = apply_multilingual_synonyms(definitions, aliases)
    with open(os.path.abspath(LOINC_ALIASES_PATH), "w", encoding="utf-8") as f:
        json.dump(aliases, f)
    logger.info("Wrote %d folded-code aliases to %s", len(aliases), LOINC_ALIASES_PATH)

    reset_database()

    db = SessionLocal()
    try:
        count = seed_biomarkers(db, definitions)
        logger.info("Seeded %d / %d global biomarkers", count, len(definitions))

        # Apply curated reference ranges on top of the LOINC definitions.
        from app.db.import_ranges import COMMON_RANGES, merge_ranges
        from app.db.seed import seed_db

        seed_db(db)  # recreate default patient + any non-LOINC baseline defs
        up, skipped, not_found = merge_ranges(db, dict(COMMON_RANGES))
        logger.info("Applied ranges: %d updated, %d skipped, %d not found", up, skipped, not_found)
    finally:
        db.close()


if __name__ == "__main__":
    main()