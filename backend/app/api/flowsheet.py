from fastapi import APIRouter

from app.schemas import FlowsheetResponse, MatrixCategory, MatrixRow, MatrixCell, BiomarkerResult, BiomarkerDefinition

router = APIRouter()

MOCK_DATES = ["Feb 18", "May 05", "Jun 28", "Aug 10", "Sep 20", "Oct 15", "Dec 03", "Jan 12"]

_DEFS = {
    "wbc": ("WBC", "Лейкоциты", "Complete Blood Count", 4.0, 11.0, "K/µL"),
    "rbc": ("RBC", "Эритроциты", "Complete Blood Count", 4.2, 5.8, "M/µL"),
    "hb": ("Hemoglobin", "Гемоглобин", "Complete Blood Count", 12.0, 16.0, "g/dL"),
    "hct": ("Hematocrit", "Гематокрит", "Complete Blood Count", 36.0, 48.0, "%"),
    "plt": ("Platelets", "Тромбоциты", "Complete Blood Count", 150, 450, "K/µL"),
    "glu": ("Glucose", "Глюкоза", "Comprehensive Metabolic Panel", 65, 100, "mg/dL"),
    "bun": ("BUN", "Мочевина", "Comprehensive Metabolic Panel", 7, 25, "mg/dL"),
    "cre": ("Creatinine", "Креатинин", "Comprehensive Metabolic Panel", 0.6, 1.2, "mg/dL"),
    "ldl": ("LDL Cholesterol", "ЛПНП холестерин", "Lipid Panel", 0, 130, "mg/dL"),
    "hdl": ("HDL Cholesterol", "ЛПВП холестерин", "Lipid Panel", 40, 999, "mg/dL"),
    "trig": ("Triglycerides", "Триглицериды", "Lipid Panel", 0, 150, "mg/dL"),
    # Iron Panel
    "iron": ("Iron", "Железо", "Iron Panel", 60, 170, "µg/dL"),
    "ferritin": ("Ferritin", "Ферритин", "Iron Panel", 30, 400, "ng/mL"),
    "tibc": ("TIBC", "ОЖСС", "Iron Panel", 250, 450, "µg/dL"),
    # Thyroid Panel
    "tsh": ("TSH", "ТТГ", "Thyroid Panel", 0.4, 4.0, "mIU/L"),
    "t4": ("Free T4", "Т4 свободный", "Thyroid Panel", 0.8, 1.8, "ng/dL"),
    # Vitamins
    "b12": ("Vitamin B12", "Витамин B12", "Vitamins", 200, 900, "pg/mL"),
    "d": ("Vitamin D", "Витамин D", "Vitamins", 30, 100, "ng/mL"),
}

DATE_LABELS = ["Feb 18", "May 05", "Jun 28", "Aug 10", "Sep 20", "Oct 15", "Dec 03", "Jan 12"]
DATE_FULL = ["Feb 18, 2026", "May 05, 2026", "Jun 28, 2026", "Aug 10, 2026", "Sep 20, 2026", "Oct 15, 2026", "Dec 03, 2026", "Jan 12, 2027"]

BIOMARKER_VALUES = {
    "wbc": [5.2, 5.0, 5.3, 5.5, 6.8, 7.2, 6.5, 6.1],
    "rbc": [4.3, 4.4, 4.4, 4.5, 4.7, 4.9, 4.8, 4.7],
    "hb": [12.8, 13.0, 13.2, 13.5, 13.8, 14.2, 14.0, 13.9],
    "hct": [38.5, 39.0, 39.8, 40.2, 41.5, 42.0, 41.2, 40.8],
    "plt": [275, 268, 262, 260, 248, 255, 250, 245],
    "glu": [88, 92, 90, 95, 88, 92, 85, 90],
    "bun": [14, 15, 14, 15, 16, 18, 17, 16],
    "cre": [0.8, 0.8, 0.9, 0.8, 0.8, 0.9, 1.0, 1.1],
    "ldl": [155, 150, 148, 142, 125, 118, 115, 112],
    "hdl": [42, 44, 46, 48, 52, 55, 56, 58],
    "trig": [165, 160, 158, 155, 145, 132, 130, 128],
    "iron": [65, 72, 78, 85, 78, 72, 75, 78],
    "ferritin": [45, 40, 35, 31, 26, 22, 20, 18],
    "tibc": [320, 335, 348, 356, 372, 388, 395, 410],
    "tsh": [2.5, 2.3, 2.0, 1.8, 1.9, 2.1, 2.0, 1.8],
    "t4": [1.0, 1.0, 1.1, 1.1, 1.1, 1.2, 1.2, 1.3],
    "b12": [280, 295, 305, 310, 325, 340, 360, 380],
    "d": [38, 36, 35, 35, 32, 28, 26, 24],
}

CATEGORY_GROUPING = {
    "Complete Blood Count": ["wbc", "rbc", "hb", "hct", "plt"],
    "Comprehensive Metabolic Panel": ["glu", "bun", "cre"],
    "Lipid Panel": ["ldl", "hdl", "trig"],
    "Iron Panel": ["iron", "ferritin", "tibc"],
    "Thyroid Panel": ["tsh", "t4"],
    "Vitamins": ["b12", "d"],
}


def _status(value: float, rmin: float, rmax: float) -> str:
    if value < rmin:
        return "low"
    if value > rmax:
        return "high"
    return "normal"


MOCK_MATRIX = []
for cat_name, def_ids in CATEGORY_GROUPING.items():
    rows = []
    for def_id in def_ids:
        name_en, name_ru, _, rmin, rmax, unit = _DEFS[def_id]
        values = BIOMARKER_VALUES[def_id]
        cells = []
        for i in range(len(DATE_LABELS)):
            cells.append(MatrixCell(value=str(values[i]), status=_status(values[i], rmin, rmax)))
        rows.append(MatrixRow(
            id=def_id,
            name=name_en,
            original=name_ru,
            range=f"{rmin} – {rmax} {unit}",
            cells=cells,
        ))
    MOCK_MATRIX.append(MatrixCategory(category=cat_name, rows=rows))

MOCK_BIOMARKERS = []
for def_id, values in BIOMARKER_VALUES.items():
    name_en, name_ru, cat_name, rmin, rmax, unit = _DEFS[def_id]
    def_obj = BiomarkerDefinition(
        id=def_id, name_en=name_en, name_ru=name_ru,
        category=cat_name, range_min=rmin, range_max=rmax, unit=unit,
    )
    for i in range(len(DATE_LABELS)):
        MOCK_BIOMARKERS.append(BiomarkerResult(
            id=f"{def_id}-{DATE_LABELS[i].lower().replace(' ', '-')}",
            definition=def_obj,
            value=values[i],
            date=DATE_FULL[i],
            status=_status(values[i], rmin, rmax),
        ))


@router.get("/api/flowsheet", response_model=FlowsheetResponse)
async def get_flowsheet():
    return FlowsheetResponse(dates=MOCK_DATES, matrix=MOCK_MATRIX, biomarkers=MOCK_BIOMARKERS)
