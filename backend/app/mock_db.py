MOCK_DATABASE: list[dict] = []


def _status(value: float, rmin: float, rmax: float) -> str:
    if value < rmin:
        return "low"
    if value > rmax:
        return "high"
    return "normal"


BIOMARKER_DEFINITIONS: dict[str, dict] = {
    "wbc": {"id": "wbc", "name_en": "WBC", "name_ru": "Лейкоциты", "category": "Complete Blood Count", "range_min": 4.0, "range_max": 11.0, "unit": "K/µL"},
    "rbc": {"id": "rbc", "name_en": "RBC", "name_ru": "Эритроциты", "category": "Complete Blood Count", "range_min": 4.2, "range_max": 5.8, "unit": "M/µL"},
    "hb": {"id": "hb", "name_en": "Hemoglobin", "name_ru": "Гемоглобин", "category": "Complete Blood Count", "range_min": 12.0, "range_max": 16.0, "unit": "g/dL"},
    "hct": {"id": "hct", "name_en": "Hematocrit", "name_ru": "Гематокрит", "category": "Complete Blood Count", "range_min": 36.0, "range_max": 48.0, "unit": "%"},
    "plt": {"id": "plt", "name_en": "Platelets", "name_ru": "Тромбоциты", "category": "Complete Blood Count", "range_min": 150, "range_max": 450, "unit": "K/µL"},
    "glu": {"id": "glu", "name_en": "Glucose", "name_ru": "Глюкоза", "category": "Comprehensive Metabolic Panel", "range_min": 65, "range_max": 100, "unit": "mg/dL"},
    "bun": {"id": "bun", "name_en": "BUN", "name_ru": "Мочевина", "category": "Comprehensive Metabolic Panel", "range_min": 7, "range_max": 25, "unit": "mg/dL"},
    "cre": {"id": "cre", "name_en": "Creatinine", "name_ru": "Креатинин", "category": "Comprehensive Metabolic Panel", "range_min": 0.6, "range_max": 1.2, "unit": "mg/dL"},
    "ldl": {"id": "ldl", "name_en": "LDL Cholesterol", "name_ru": "ЛПНП холестерин", "category": "Lipid Panel", "range_min": 0, "range_max": 130, "unit": "mg/dL"},
    "hdl": {"id": "hdl", "name_en": "HDL Cholesterol", "name_ru": "ЛПВП холестерин", "category": "Lipid Panel", "range_min": 40, "range_max": 999, "unit": "mg/dL"},
    "trig": {"id": "trig", "name_en": "Triglycerides", "name_ru": "Триглицериды", "category": "Lipid Panel", "range_min": 0, "range_max": 150, "unit": "mg/dL"},
    "iron": {"id": "iron", "name_en": "Iron", "name_ru": "Железо", "category": "Iron Panel", "range_min": 60, "range_max": 170, "unit": "µg/dL"},
    "ferritin": {"id": "ferritin", "name_en": "Ferritin", "name_ru": "Ферритин", "category": "Iron Panel", "range_min": 30, "range_max": 400, "unit": "ng/mL"},
    "tibc": {"id": "tibc", "name_en": "TIBC", "name_ru": "ОЖСС", "category": "Iron Panel", "range_min": 250, "range_max": 450, "unit": "µg/dL"},
    "tsh": {"id": "tsh", "name_en": "TSH", "name_ru": "ТТГ", "category": "Thyroid Panel", "range_min": 0.4, "range_max": 4.0, "unit": "mIU/L"},
    "t4": {"id": "t4", "name_en": "Free T4", "name_ru": "Т4 свободный", "category": "Thyroid Panel", "range_min": 0.8, "range_max": 1.8, "unit": "ng/dL"},
    "b12": {"id": "b12", "name_en": "Vitamin B12", "name_ru": "Витамин B12", "category": "Vitamins", "range_min": 200, "range_max": 900, "unit": "pg/mL"},
    "d": {"id": "d", "name_en": "Vitamin D", "name_ru": "Витамин D", "category": "Vitamins", "range_min": 30, "range_max": 100, "unit": "ng/mL"},
}

CATEGORY_GROUPING: dict[str, list[str]] = {
    "Complete Blood Count": ["wbc", "rbc", "hb", "hct", "plt"],
    "Comprehensive Metabolic Panel": ["glu", "bun", "cre"],
    "Lipid Panel": ["ldl", "hdl", "trig"],
    "Iron Panel": ["iron", "ferritin", "tibc"],
    "Thyroid Panel": ["tsh", "t4"],
    "Vitamins": ["b12", "d"],
}

BLOOD_TEST_IDS = ["blood-feb", "blood-may", "blood-jun", "blood-aug", "blood-sep", "blood-oct", "blood-dec", "blood-jan"]

BLOOD_TEST_DATES = [
    "Feb 18, 2026", "May 05, 2026", "Jun 28, 2026", "Aug 10, 2026",
    "Sep 20, 2026", "Oct 15, 2026", "Dec 03, 2026", "Jan 12, 2027",
]

BLOOD_TEST_TITLES = [
    "Pre-Operative Baseline", "Annual Physical Labs", "Follow-up Panel", "Pre-Surgery Panel",
    "Routine Blood Draw", "Comprehensive Blood Panel", "Quarterly Monitoring", "New Year Baseline",
]

BLOOD_TEST_SUBTITLES = [
    "CBC, PT/PTT, Type & Screen", "CBC, CMP, Lipid Panel", "CBC, Basic Metabolic", "CBC, PT/PTT, Type & Screen",
    "CBC, Basic Metabolic", "CBC, CMP, Lipid Panel", "CBC, CMP, Iron Panel, Lipid Panel", "CBC, CMP, Lipid Panel, Iron Panel, Thyroid, Vitamins",
]

BLOOD_TEST_CLINICS = [
    "CityLab Diagnostics", "Invitro Lab", "Invitro Lab", "CityLab Diagnostics",
    "Invitro Lab", "Invitro Lab", "Invitro Lab", "CityLab Diagnostics",
]

BLOOD_ATTACHMENTS: dict[str, list[dict]] = {
    "blood-feb": [{"id": "feb-lab", "name": "PreOp_Lab_Report_Feb2026.pdf", "type": "Lab Report", "size": "312 KB"}],
    "blood-may": [{"id": "may-lab", "name": "Annual_Lab_Report_May2026.pdf", "type": "Lab Report", "size": "198 KB"}],
    "blood-jun": [{"id": "jun-lab", "name": "FollowUp_Lab_Report_Jun2026.pdf", "type": "Lab Report", "size": "176 KB"}],
    "blood-aug": [{"id": "aug-lab", "name": "PreSurgery_Lab_Report_Aug2026.pdf", "type": "Lab Report", "size": "284 KB"}],
    "blood-oct": [{"id": "r1", "name": "Lab_Report_Oct2026.pdf", "type": "Lab Report", "size": "245 KB"}],
    "blood-dec": [{"id": "dec-lab", "name": "Quarterly_Lab_Report_Dec2026.pdf", "type": "Lab Report", "size": "220 KB"}],
    "blood-jan": [{"id": "jan-lab", "name": "NewYear_Baseline_Lab_Report_Jan2027.pdf", "type": "Lab Report", "size": "356 KB"}],
}

BIOMARKER_VALUES: dict[str, list[float]] = {
    "wbc": [5.2, 5.0, 15.8, 5.5, 6.8, 7.2, 14.2, 6.1],
    "rbc": [4.3, 4.4, 4.4, 4.5, 4.7, 4.9, 4.8, 4.7],
    "hb": [12.8, 13.0, 10.1, 13.5, 13.8, 14.2, 14.0, 13.9],
    "hct": [38.5, 39.0, 39.8, 40.2, 41.5, 42.0, 41.2, 40.8],
    "plt": [275, 268, 55, 260, 248, 255, 250, 245],
    "glu": [88, 92, 185, 95, 88, 92, 210, 90],
    "bun": [14, 15, 14, 15, 16, 18, 17, 16],
    "cre": [0.8, 0.8, 2.1, 0.8, 0.8, 0.9, 2.4, 1.1],
    "ldl": [155, 150, 148, 142, 125, 118, 195, 112],
    "hdl": [42, 44, 46, 48, 52, 55, 56, 58],
    "trig": [165, 160, 158, 155, 145, 132, 130, 128],
    "iron": [65, 72, 22, 85, 78, 72, 75, 78],
    "ferritin": [45, 40, 35, 31, 26, 22, 8, 18],
    "tibc": [320, 335, 348, 356, 372, 388, 395, 410],
    "tsh": [2.5, 2.3, 2.0, 1.8, 1.9, 2.1, 2.0, 1.8],
    "t4": [1.0, 1.0, 1.1, 1.1, 1.1, 1.2, 1.2, 1.3],
    "b12": [280, 295, 305, 310, 325, 340, 360, 380],
    "d": [38, 36, 35, 35, 32, 28, 12, 24],
}


def _build_biomarkers_for_date(date_idx: int) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for bid, values in BIOMARKER_VALUES.items():
        v = values[date_idx]
        defn = BIOMARKER_DEFINITIONS[bid]
        result[bid] = {
            "value": v,
            "status": _status(v, defn["range_min"], defn["range_max"]),
        }
    return result


DOCTOR_VISITS: list[dict] = [
    {
        "id": "cardio",
        "type": "doctor_visit",
        "date": "Sep 05, 2026",
        "title": "Cardiology Follow-up",
        "subtitle": "Dr. Elena Ivanova",
        "category": "Cardiology",
        "status": "Completed",
        "clinic": "Central Heart Institute",
        "attachments": [
            {"id": "consult", "name": "Consultation_Notes_Sep2026.pdf", "type": "Physician commentary", "size": "128 KB"},
            {"id": "ekg", "name": "EKG_Strip_Scan.pdf", "type": "Diagnostic image", "size": "2.1 MB"},
        ],
        "visit_data": {
            "specialty": "Cardiology Follow-up",
            "provider": "Dr. Elena Ivanova, MD",
            "date": "Sep 05, 2026",
            "clinic": "Central Heart Institute",
            "verdict": "Mild Sinus Tachycardia - Under Control. Patient responding well to current regimen.",
            "notes": [
                {"heading": "Chief Complaint & Subjective", "text": "Patient reports occasional palpitations during heavy exercise. Denies chest pain, shortness of breath, or dizziness. Mentions feeling generally fatigued in the mornings."},
                {"heading": None, "text": "Vitals taken at desk: BP 118/76, HR 88 bpm, O2 99%. Weight stable."},
                {"heading": "Objective Findings", "text": "Heart rhythm is regular. No murmurs, gallops, or rubs heard. Lungs are clear to auscultation bilaterally. EKG performed in-office reveals Normal Sinus Rhythm, rate 88, with no ST-T wave abnormalities."},
            ],
            "prescriptions": [
                {"id": 1, "name": "Metoprolol Succinate", "dose": "25mg", "instruction": "1 tablet daily (morning)"},
            ],
            "recommendations": [
                "Schedule 6-month follow-up EKG and consultation.",
                "Comprehensive Metabolic Panel (CMP) prior to next visit.",
            ],
        },
    },
    {
        "id": "ortho",
        "type": "doctor_visit",
        "date": "Aug 22, 2026",
        "title": "Orthopedic Consultation",
        "subtitle": "Dr. James Mitchell, DO",
        "category": "Orthopedics",
        "status": "Completed",
        "clinic": "Northern Sports Medicine",
        "attachments": [],
        "visit_data": {
            "specialty": "Orthopedic Consultation",
            "provider": "Dr. James Mitchell, DO",
            "date": "Aug 22, 2026",
            "clinic": "Northern Sports Medicine",
            "verdict": "Left knee patellar tendinopathy (Jumper's Knee). MRI confirms mild tendinosis without tear.",
            "notes": [
                {"heading": "Chief Complaint", "text": "Left anterior knee pain for 3 months, worse with squatting and stairs. Patient is a recreational basketball player."},
                {"heading": "Physical Exam", "text": "Tenderness over patellar tendon at tibial insertion. Pain with resisted knee extension. No effusion. Full range of motion."},
                {"heading": "Imaging Review", "text": "MRI left knee: Mild thickening and signal increase in proximal patellar tendon consistent with tendinosis. No tear."},
            ],
            "prescriptions": [
                {"id": 2, "name": "Ibuprofen", "dose": "400mg", "instruction": "Take 1 tablet twice daily with food as needed for pain"},
            ],
            "recommendations": [
                "Physical therapy 2x/week for 6 weeks focusing on eccentric quad strengthening.",
                "Activity modification - avoid jumping and deep squatting for 4 weeks.",
                "Follow-up in 8 weeks with repeat clinical assessment.",
            ],
        },
    },
    {
        "id": "neuro",
        "type": "doctor_visit",
        "date": "Oct 18, 2026",
        "title": "Neurology Assessment",
        "subtitle": "Dr. S. Reynolds, MD, PhD",
        "category": "Neurology",
        "status": "Scheduled",
        "clinic": "Neurology Associates",
        "attachments": [
            {"id": "neuro-ref", "name": "Neurology_Referral.pdf", "type": "Referral letter", "size": "92 KB"},
        ],
        "visit_data": {
            "specialty": "Neurology Assessment",
            "provider": "Dr. S. Reynolds, MD, PhD",
            "date": "Oct 18, 2026",
            "clinic": "Neurology Associates",
            "verdict": "Suspected Migraine with Brainstem Aura. MRI brain scheduled to rule out structural causes.",
            "notes": [
                {"heading": "Chief Complaint", "text": "Patient reports recurrent episodes of vertigo, blurred vision, and unilateral throbbing headache lasting 4-72 hours. Episodes increased in frequency over the past 2 months — now 3-4 per month."},
                {"heading": None, "text": "Patient also notes photophobia, phonophobia, and occasional nausea during episodes. No aura prior to onset. Family history positive for migraines (mother)."},
                {"heading": "Physical Exam", "text": "Cranial nerves II-XII intact. Motor strength 5/5 throughout. Sensation intact. Reflexes 2+ and symmetric. Coordination and gait normal. No papilledema on fundoscopy."},
                {"heading": "Assessment", "text": "1. Migraine without aura (G43.0) — likely diagnosis. 2. Rule out brainstem pathology with MRI. 3. Consider starting prophylactic therapy if frequency exceeds 4/month."},
            ],
            "prescriptions": [
                {"id": 3, "name": "Sumatriptan Succinate", "dose": "50mg", "instruction": "Take 1 tablet at onset of migraine; may repeat once after 2 hours if no relief (max 2/day)"},
                {"id": 4, "name": "Vitamin B2 (Riboflavin)", "dose": "400mg", "instruction": "1 tablet daily for migraine prophylaxis"},
            ],
            "recommendations": [
                "MRI brain with and without contrast to rule out structural causes.",
                "Keep headache diary for 8 weeks tracking triggers, frequency, and severity.",
                "Follow-up in 4 weeks to review MRI results and assess response to Sumatriptan.",
                "Consider neurology referral if symptoms worsen or atypical features develop.",
            ],
        },
    },
]

PROCEDURES: list[dict] = [
    {
        "id": "derm",
        "type": "procedure",
        "date": "Sep 12, 2026",
        "title": "Skin Biopsy",
        "subtitle": "Left upper arm",
        "category": "Dermatology",
        "status": "Completed",
        "clinic": "Dermatology Clinic",
        "attachments": [
            {"id": "path", "name": "Pathology_Report.pdf", "type": "Pathology", "size": "890 KB"},
        ],
    },
]


def _seed() -> None:
    for i, eid in enumerate(BLOOD_TEST_IDS):
        biomarkers = _build_biomarkers_for_date(i)
        if eid == "blood-feb":
            for k in ["iron", "ferritin", "tibc", "tsh", "t4", "b12", "d"]:
                biomarkers.pop(k, None)
        if eid == "blood-sep":
            for k in ["ldl", "hdl", "trig", "iron", "ferritin", "tibc"]:
                biomarkers.pop(k, None)
        if eid == "blood-jan":
            for k in ["b12", "d"]:
                biomarkers.pop(k, None)
        MOCK_DATABASE.append({
            "id": eid,
            "type": "blood_test",
            "date": BLOOD_TEST_DATES[i],
            "title": BLOOD_TEST_TITLES[i],
            "subtitle": BLOOD_TEST_SUBTITLES[i],
            "category": "Labs",
            "status": "Completed",
            "clinic": BLOOD_TEST_CLINICS[i],
            "attachments": BLOOD_ATTACHMENTS.get(eid, []),
            "biomarkers": biomarkers,
        })

    MOCK_DATABASE.extend(DOCTOR_VISITS)
    MOCK_DATABASE.extend(PROCEDURES)


_seed()
