"""
Import reference ranges for common LOINC codes from a curated JSON file.
Merges ranges into existing global biomarker definitions.

Usage:
    python -m app.db.import_ranges
"""

import json
import logging
import os
import sys

from app.db.session import SessionLocal
from app.db import models  # noqa: F401

logger = logging.getLogger(__name__)

# Curated reference ranges for common blood tests
# Format: LOINC_NUM -> {"range_min": float, "range_max": float, "unit": str, "source": str}
# Sources: "mock_db" (from mock_db.py), "labcorp", "quest", "nih", "community"
COMMON_RANGES = {
    # Complete Blood Count
    "6690-2": {"range_min": 4.0, "range_max": 11.0, "unit": "10*3/uL", "source": "mock_db"},      # WBC
    "789-8":  {"range_min": 4.2, "range_max": 5.8, "unit": "10*6/uL", "source": "mock_db"},       # RBC
    "718-7":  {"range_min": 12.0, "range_max": 16.0, "unit": "g/dL", "source": "mock_db"},        # Hemoglobin
    "4544-3": {"range_min": 36.0, "range_max": 48.0, "unit": "%", "source": "mock_db"},           # Hematocrit
    "777-3":  {"range_min": 150, "range_max": 450, "unit": "10*3/uL", "source": "mock_db"},       # Platelets

    # Comprehensive Metabolic Panel
    "2345-7": {"range_min": 65, "range_max": 100, "unit": "mg/dL", "source": "mock_db"},          # Glucose
    "3094-0": {"range_min": 7, "range_max": 25, "unit": "mg/dL", "source": "mock_db"},            # BUN
    "2160-0": {"range_min": 0.6, "range_max": 1.2, "unit": "mg/dL", "source": "mock_db"},         # Creatinine
    "2951-2": {"range_min": 96, "range_max": 106, "unit": "mmol/L", "source": "community"},       # Chloride
    "2823-3": {"range_min": 3.5, "range_max": 5.0, "unit": "mmol/L", "source": "community"},      # Potassium
    "2950-4": {"range_min": 135, "range_max": 145, "unit": "mmol/L", "source": "community"},       # Sodium (correct LOINC)
    "2075-0": {"range_min": 22, "range_max": 29, "unit": "mmol/L", "source": "community"},        # CO2
    "1975-2": {"range_min": 0.3, "range_max": 1.2, "unit": "mg/dL", "source": "community"},       # Bilirubin total
    "1742-6": {"range_min": 7, "range_max": 56, "unit": "U/L", "source": "community"},            # ALT
    "1920-8": {"range_min": 10, "range_max": 40, "unit": "U/L", "source": "community"},           # AST
    "6768-6": {"range_min": 44, "range_max": 147, "unit": "U/L", "source": "community"},          # ALP
    "2885-2": {"range_min": 6.0, "range_max": 8.3, "unit": "g/dL", "source": "community"},        # Total protein
    "1751-7": {"range_min": 3.5, "range_max": 5.0, "unit": "g/dL", "source": "community"},        # Albumin
    "2324-2": {"range_min": 0.8, "range_max": 1.2, "unit": "mg/dL", "source": "community"},       # Calcium
    "2498-4": {"range_min": 60, "range_max": 170, "unit": "ug/dL", "source": "mock_db"},          # Iron
    "2276-4": {"range_min": 30, "range_max": 400, "unit": "ng/mL", "source": "mock_db"},          # Ferritin
    "2503-1": {"range_min": 250, "range_max": 450, "unit": "ug/dL", "source": "mock_db"},         # TIBC (correct LOINC)

    # Lipid Panel
    "2089-1": {"range_min": 0, "range_max": 130, "unit": "mg/dL", "source": "mock_db"},           # LDL
    "2085-9": {"range_min": 40, "range_max": 999, "unit": "mg/dL", "source": "mock_db"},          # HDL
    "2571-8": {"range_min": 0, "range_max": 150, "unit": "mg/dL", "source": "mock_db"},           # Triglycerides
    "2093-3": {"range_min": 125, "range_max": 200, "unit": "mg/dL", "source": "community"},       # Total cholesterol (correct LOINC)

    # Thyroid
    "3016-3": {"range_min": 0.4, "range_max": 4.0, "unit": "mIU/L", "source": "mock_db"},         # TSH
    "2542-8": {"range_min": 2.0, "range_max": 4.4, "unit": "pg/mL", "source": "community"},       # Free T3

    # Vitamins
    "2132-9": {"range_min": 200, "range_max": 900, "unit": "pg/mL", "source": "mock_db"},         # B12
    "39492-1": {"range_min": 30, "range_max": 100, "unit": "ng/mL", "source": "mock_db"},         # Vitamin D
    "1910-0": {"range_min": 3.0, "range_max": 17.0, "unit": "ng/mL", "source": "community"},      # Folate

    # Coagulation
    "5902-2": {"range_min": 11, "range_max": 13.5, "unit": "s", "source": "community"},           # PT
    "3256-4": {"range_min": 0.8, "range_max": 1.2, "unit": "", "source": "community"},            # INR
    "3265-5": {"range_min": 25, "range_max": 35, "unit": "s", "source": "community"},             # aPTT

    # Inflammation
    "30355-7": {"range_min": 0, "range_max": 10, "unit": "mg/L", "source": "community"},          # CRP
    "1752-5": {"range_min": 0, "range_max": 20, "unit": "mm/h", "source": "community"},           # ESR

    # Cardiac
    "10839-9": {"range_min": 0, "range_max": 0.04, "unit": "ng/mL", "source": "community"},       # Troponin I
    "20880-9": {"range_min": 0, "range_max": 100, "unit": "pg/mL", "source": "community"},        # BNP
    "2956-1": {"range_min": 0, "range_max": 1.0, "unit": "ng/mL", "source": "community"},         # CK-MB

    # Liver
    "2335-8": {"range_min": 0, "range_max": 60, "unit": "U/L", "source": "community"},            # GGT
    "2286-9": {"range_min": 5, "range_max": 45, "unit": "U/L", "source": "community"},            # LD/LDH

    # Kidney
    "2164-2": {"range_min": 3.5, "range_max": 7.2, "unit": "mg/dL", "source": "community"},       # Uric acid
    "38483-4": {"range_min": 0.6, "range_max": 1.2, "unit": "mg/dL", "source": "community"},      # Creatinine (blood)
    "2161-8": {"range_min": 60, "range_max": 120, "unit": "mL/min", "source": "community"},       # eGFR

    # Hormones
    "1825-7": {"range_min": 200, "range_max": 900, "unit": "ng/dL", "source": "community"},       # Testosterone total
    "1826-5": {"range_min": 15, "range_max": 70, "unit": "pg/mL", "source": "community"},         # Estradiol
    "2598-1": {"range_min": 0.1, "range_max": 0.7, "unit": "ng/mL", "source": "community"},       # Progesterone
    "3859-1": {"range_min": 1.5, "range_max": 12.4, "unit": "mIU/mL", "source": "community"},     # FSH
    "3860-9": {"range_min": 1.7, "range_max": 8.6, "unit": "mIU/mL", "source": "community"},      # LH
    "3861-7": {"range_min": 2, "range_max": 18, "unit": "ng/mL", "source": "community"},          # Prolactin

    # Tumor markers
    "2857-1": {"range_min": 0, "range_max": 4.0, "unit": "ng/mL", "source": "community"},         # PSA
    "2858-9": {"range_min": 0, "range_max": 35, "unit": "U/mL", "source": "community"},           # CA-125
    "2859-7": {"range_min": 0, "range_max": 37, "unit": "U/mL", "source": "community"},           # CA 19-9
    "2860-5": {"range_min": 0, "range_max": 10, "unit": "ng/mL", "source": "community"},          # CEA
    "2861-3": {"range_min": 0, "range_max": 10, "unit": "IU/mL", "source": "community"},          # AFP

    # Additional common
    "1759-0": {"range_min": 5.0, "range_max": 7.5, "unit": "", "source": "community"},            # pH (blood)
    "1963-8": {"range_min": 35, "range_max": 45, "unit": "mmHg", "source": "community"},          # pCO2
    "1960-4": {"range_min": 7.35, "range_max": 7.45, "unit": "", "source": "community"},          # pH
    "1967-1": {"range_min": 22, "range_max": 26, "unit": "mmol/L", "source": "community"},        # HCO3
    "2059-6": {"range_min": 95, "range_max": 105, "unit": "mmHg", "source": "community"},         # pO2
    "2028-9": {"range_min": 10, "range_max": 30, "unit": "mmol/L", "source": "community"},        # CO2 total
    "38527-1": {"range_min": 0.7, "range_max": 1.2, "unit": "mmol/L", "source": "community"},     # Lactate
    "2339-0": {"range_min": 0, "range_max": 150, "unit": "U/L", "source": "community"},           # Amylase
    "2574-2": {"range_min": 0, "range_max": 160, "unit": "U/L", "source": "community"},           # Lipase
    "30252-6": {"range_min": 0.8, "range_max": 1.8, "unit": "ng/dL", "source": "mock_db"},        # Free T4

    # HBA1c
    "17856-6": {"range_min": 4.0, "range_max": 5.6, "unit": "%", "source": "mock_db"},            # HbA1c
    "4548-4":  {"range_min": 4.0, "range_max": 5.6, "unit": "%", "source": "mock_db"},            # HbA1c (alt IFCC)

    # D-dimer
    "48057-4": {"range_min": 0, "range_max": 500, "unit": "ng/mL", "source": "community"},        # D-dimer

    # Fibrinogen
    "3255-6": {"range_min": 200, "range_max": 400, "unit": "mg/dL", "source": "community"},       # Fibrinogen

    # Homocysteine
    "39528-9": {"range_min": 5, "range_max": 15, "unit": "umol/L", "source": "community"},        # Homocysteine

    # Methylmalonic acid
    "39488-6": {"range_min": 0, "range_max": 400, "unit": "nmol/L", "source": "community"},       # MMA

    # Transferrin saturation (calculated)
    "35542-2": {"range_min": 20, "range_max": 50, "unit": "%", "source": "community"},            # Transferrin saturation (correct LOINC)

    # Reticulocytes
    "746-3": {"range_min": 0.5, "range_max": 1.5, "unit": "%", "source": "community"},            # Reticulocyte count

    # MCH, MCHC, MCV
    "785-6": {"range_min": 27, "range_max": 31, "unit": "pg", "source": "community"},             # MCH
    "786-4": {"range_min": 32, "range_max": 36, "unit": "g/dL", "source": "community"},           # MCHC
    "787-2": {"range_min": 80, "range_max": 100, "unit": "fL", "source": "community"},            # MCV

    # RDW
    "788-0": {"range_min": 11.5, "range_max": 14.5, "unit": "%", "source": "community"},          # RDW

    # MPV (correct LOINC - was sharing 777-3 with Platelets)
    "32623-1": {"range_min": 7.5, "range_max": 11.5, "unit": "fL", "source": "community"},        # MPV

    # Neutrophils, Lymphocytes, etc.
    "26476-2": {"range_min": 1.5, "range_max": 7.0, "unit": "10*3/uL", "source": "community"},    # Lymphocytes
    "26515-7": {"range_min": 1.5, "range_max": 7.5, "unit": "10*3/uL", "source": "community"},    # Neutrophils (approx)

    # Eosinophils, Basophils, Monocytes
    "26475-4": {"range_min": 0, "range_max": 0.5, "unit": "10*3/uL", "source": "community"},      # Eosinophils
    "26477-0": {"range_min": 0, "range_max": 0.1, "unit": "10*3/uL", "source": "community"},      # Basophils
    "26474-7": {"range_min": 0.2, "range_max": 0.8, "unit": "10*3/uL", "source": "community"},    # Monocytes
}


def load_ranges_from_file(path: str) -> dict:
    """Load ranges from external JSON file if it exists."""
    if not os.path.isfile(path):
        return {}
    with open(path, "r") as f:
        return json.load(f)


def merge_ranges(db, ranges: dict, dry_run: bool = False):
    updated = 0
    skipped = 0
    not_found = 0

    for loinc_code, range_data in ranges.items():
        defn = db.query(models.BiomarkerDefinition).filter(
            models.BiomarkerDefinition.loinc_code == loinc_code
        ).first()

        if not defn:
            not_found += 1
            logger.debug("LOINC %s not found in DB", loinc_code)
            continue

        # Only update if we have range data and definition doesn't already have it
        if defn.range_min is not None and defn.range_max is not None:
            skipped += 1
            logger.debug("LOINC %s already has ranges, skipping", loinc_code)
            continue

        range_min = range_data.get("range_min")
        range_max = range_data.get("range_max")
        unit = range_data.get("unit")
        source = range_data.get("source", "imported")

        if range_min is not None or range_max is not None:
            if not dry_run:
                defn.range_min = range_min
                defn.range_max = range_max
                if unit and not defn.unit:
                    defn.unit = unit
                defn.range_source = source
            updated += 1
            logger.info("Updated %s (LOINC %s): range=%s-%s %s [source=%s]",
                        defn.names.get("en", defn.id), loinc_code, range_min, range_max, unit, source)

    if not dry_run:
        db.commit()
    return updated, skipped, not_found


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Import reference ranges for LOINC codes")
    parser.add_argument("--file", "-f", help="Path to JSON file with ranges", default=None)
    parser.add_argument("--dry-run", action="store_true", help="Show what would be updated without committing")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    # Start with built-in ranges
    all_ranges = dict(COMMON_RANGES)

    # Merge from external file if provided
    if args.file:
        file_ranges = load_ranges_from_file(args.file)
        all_ranges.update(file_ranges)
        logger.info("Loaded %d ranges from %s", len(file_ranges), args.file)

    logger.info("Total ranges to process: %d", len(all_ranges))

    db = SessionLocal()
    try:
        updated, skipped, not_found = merge_ranges(db, all_ranges, dry_run=args.dry_run)
        logger.info("Done: %d updated, %d skipped (already had ranges), %d not found in DB",
                    updated, skipped, not_found)
    finally:
        db.close()


if __name__ == "__main__":
    main()