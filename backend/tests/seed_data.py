from datetime import datetime, timezone

from app.auth import get_password_hash as hash_password
from app.db.models import (
    Attachment,
    BiomarkerDefinition,
    BiomarkerReading,
    MedicalEntry,
    Patient,
    VisitData,
)

# Use a consistent test user ID
TEST_USER_ID = "testuser"
TEST_USER_EMAIL = "test@example.com"
TEST_USER_PASSWORD = "testpassword123"

# Anonymous test user ID
TEST_ANON_ID = "anon-testuser"


def _status(value: float, reference: dict) -> str:
    from app.services.reference import compute_status
    return compute_status(value, reference)


BIOMARKER_DEFINITIONS: dict[str, dict] = {
    "wbc": {"id": "wbc", "loinc_code": "6690-2", "names": {"en": "WBC", "ru": "Лейкоциты", "es": "Leucocitos", "de": "Leukozyten", "fr": "Globules blancs", "he": "תאי דם לבנים"}, "synonyms": ["white blood cells", "leukocytes", "leucocytes"], "category": "Complete Blood Count", "reference": {"kind": "interval", "low": 4.0, "high": 11.0}, "unit": "K/µL", "scope": "global", "user_id": None},
    "rbc": {"id": "rbc", "loinc_code": "789-8", "names": {"en": "RBC", "ru": "Эритроциты", "es": "Eritrocitos", "de": "Erythrozyten", "fr": "Globules rouges", "he": "תאי דם אדומים"}, "synonyms": ["red blood cells", "erythrocytes"], "category": "Complete Blood Count", "reference": {"kind": "interval", "low": 4.2, "high": 5.8}, "unit": "M/µL", "scope": "global", "user_id": None},
    "hb": {"id": "hb", "loinc_code": "718-7", "names": {"en": "Hemoglobin", "ru": "Гемоглобин", "es": "Hemoglobina", "de": "Hämoglobin", "fr": "Hémoglobine", "he": "המוגלובין"}, "synonyms": ["haemoglobin", "hgb", "hgb"], "category": "Complete Blood Count", "reference": {"kind": "interval", "low": 12.0, "high": 16.0}, "unit": "g/dL", "scope": "global", "user_id": None},
    "hct": {"id": "hct", "loinc_code": "4544-3", "names": {"en": "Hematocrit", "ru": "Гематокрит", "es": "Hematocrito", "de": "Hämatokrit", "fr": "Hématocrite", "he": "המטוקריט"}, "synonyms": ["haematocrit", "hct", "packed cell volume", "pcv"], "category": "Complete Blood Count", "reference": {"kind": "interval", "low": 36.0, "high": 48.0}, "unit": "%", "scope": "global", "user_id": None},
    "plt": {"id": "plt", "loinc_code": "777-3", "names": {"en": "Platelets", "ru": "Тромбоциты", "es": "Plaquetas", "de": "Thrombozyten", "fr": "Plaquettes", "he": "טסיות"}, "synonyms": ["platelet count", "thrombocytes", "plt count"], "category": "Complete Blood Count", "reference": {"kind": "interval", "low": 150, "high": 450}, "unit": "K/µL", "scope": "global", "user_id": None},
    "glu": {"id": "glu", "loinc_code": "2345-7", "names": {"en": "Glucose", "ru": "Глюкоза", "es": "Glucosa", "de": "Glukose", "fr": "Glucose", "he": "גלוקוז"}, "synonyms": ["blood sugar", "fasting glucose", "glu"], "category": "Comprehensive Metabolic Panel", "reference": {"kind": "interval", "low": 65, "high": 100}, "unit": "mg/dL", "scope": "global", "user_id": None},
    "bun": {"id": "bun", "loinc_code": "3094-0", "names": {"en": "BUN", "ru": "Мочевина", "es": "BUN", "de": "Harnstoff", "fr": "Urée", "he": "אוריאה"}, "synonyms": ["blood urea nitrogen", "urea nitrogen", "urea"], "category": "Comprehensive Metabolic Panel", "reference": {"kind": "interval", "low": 7, "high": 25}, "unit": "mg/dL", "scope": "global", "user_id": None},
    "cre": {"id": "cre", "loinc_code": "2160-0", "names": {"en": "Creatinine", "ru": "Креатинин", "es": "Creatinina", "de": "Kreatinin", "fr": "Créatinine", "he": "קריאטינין"}, "synonyms": ["creat", "serum creatinine"], "category": "Comprehensive Metabolic Panel", "reference": {"kind": "interval", "low": 0.6, "high": 1.2}, "unit": "mg/dL", "scope": "global", "user_id": None},
    "ldl": {"id": "ldl", "loinc_code": "2089-1", "names": {"en": "LDL Cholesterol", "ru": "ЛПНП холестерин", "es": "Colesterol LDL", "de": "LDL-Cholesterin", "fr": "Cholestérol LDL", "he": "כולסטרול LDL"}, "synonyms": ["ldl-c", "low-density lipoprotein", "bad cholesterol"], "category": "Lipid Panel", "reference": {"kind": "interval", "low": 0, "high": 130}, "unit": "mg/dL", "scope": "global", "user_id": None},
    "hdl": {"id": "hdl", "loinc_code": "2085-9", "names": {"en": "HDL Cholesterol", "ru": "ЛПВП холестерин", "es": "Colesterol HDL", "de": "HDL-Cholesterin", "fr": "Cholestérol HDL", "he": "כולסטרול HDL"}, "synonyms": ["hdl-c", "high-density lipoprotein", "good cholesterol"], "category": "Lipid Panel", "reference": {"kind": "interval", "low": 40, "high": 999}, "unit": "mg/dL", "scope": "global", "user_id": None},
    "trig": {"id": "trig", "loinc_code": "2571-8", "names": {"en": "Triglycerides", "ru": "Триглицериды", "es": "Triglicéridos", "de": "Triglyceride", "fr": "Triglycérides", "he": "טריגליצרידים"}, "synonyms": ["trig", "tg", "triacylglycerol"], "category": "Lipid Panel", "reference": {"kind": "interval", "low": 0, "high": 150}, "unit": "mg/dL", "scope": "global", "user_id": None},
    "iron": {"id": "iron", "loinc_code": "2498-4", "names": {"en": "Iron", "ru": "Железо", "es": "Hierro", "de": "Eisen", "fr": "Fer", "he": "ברזל"}, "synonyms": ["serum iron", "fe", "iron panel"], "category": "Iron Panel", "reference": {"kind": "interval", "low": 60, "high": 170}, "unit": "µg/dL", "scope": "global", "user_id": None},
    "ferritin": {"id": "ferritin", "loinc_code": "2276-4", "names": {"en": "Ferritin", "ru": "Ферритин", "es": "Ferritina", "de": "Ferritin", "fr": "Ferritine", "he": "פריטין"}, "synonyms": ["serum ferritin", "ferritin level"], "category": "Iron Panel", "reference": {"kind": "interval", "low": 30, "high": 400}, "unit": "ng/mL", "scope": "global", "user_id": None},
    "tibc": {"id": "tibc", "loinc_code": "35234-4", "names": {"en": "TIBC", "ru": "ОЖСС", "es": "TIBC", "de": "TIBC", "fr": "CTLF", "he": "TIBC"}, "synonyms": ["total iron binding capacity", "iron binding capacity"], "category": "Iron Panel", "reference": {"kind": "interval", "low": 250, "high": 450}, "unit": "µg/dL", "scope": "global", "user_id": None},
    "tsh": {"id": "tsh", "loinc_code": "3016-3", "names": {"en": "TSH", "ru": "ТТГ", "es": "TSH", "de": "TSH", "fr": "TSH", "he": "TSH"}, "synonyms": ["thyroid stimulating hormone", "thyrotropin", "sTSH"], "category": "Thyroid Panel", "reference": {"kind": "interval", "low": 0.4, "high": 4.0}, "unit": "mIU/L", "scope": "global", "user_id": None},
    "t4": {"id": "t4", "loinc_code": "30252-6", "names": {"en": "Free T4", "ru": "Т4 свободный", "es": "T4 libre", "de": "Freies T4", "fr": "T4 libre", "he": "T4 חופשי"}, "synonyms": ["free thyroxine", "fT4", "thyroxine free"], "category": "Thyroid Panel", "reference": {"kind": "interval", "low": 0.8, "high": 1.8}, "unit": "ng/dL", "scope": "global", "user_id": None},
    "b12": {"id": "b12", "loinc_code": "2132-9", "names": {"en": "Vitamin B12", "ru": "Витамин B12", "es": "Vitamina B12", "de": "Vitamin B12", "fr": "Vitamine B12", "he": "ויטמין B12"}, "synonyms": ["cobalamin", "b12", "cyanocobalamin"], "category": "Vitamins", "reference": {"kind": "interval", "low": 200, "high": 900}, "unit": "pg/mL", "scope": "global", "user_id": None},
    "d": {"id": "d", "loinc_code": "39492-1", "names": {"en": "Vitamin D", "ru": "Витамин D", "es": "Vitamina D", "de": "Vitamin D", "fr": "Vitamine D", "he": "ויטמין D"}, "synonyms": ["25-hydroxyvitamin D", "25(OH)D", "calcidiol", "vitamin D total"], "category": "Vitamins", "reference": {"kind": "interval", "low": 30, "high": 100}, "unit": "ng/mL", "scope": "global", "user_id": None},
}

CATEGORY_GROUPING: dict[str, list[str]] = {
    "Complete Blood Count": ["wbc", "rbc", "hb", "hct", "plt"],
    "Comprehensive Metabolic Panel": ["glu", "bun", "cre"],
    "Lipid Panel": ["ldl", "hdl", "trig"],
    "Iron Panel": ["iron", "ferritin", "tibc"],
    "Thyroid Panel": ["tsh", "t4"],
    "Vitamins": ["b12", "d"],
}

BLOOD_TEST_IDS = ["blood-feb", "blood-may", "blood-jun", "blood-aug", "blood-sep", "blood-oct", "blood-oct-eve", "blood-dec", "blood-jan"]

BLOOD_TEST_DATES = [
    "2024-02-18", "2024-05-05", "2024-06-28", "2024-08-10",
    "2024-09-20", "2024-10-15T09:00", "2024-10-15T14:30", "2024-12-03", "2025-01-12",
]

BLOOD_TEST_TITLES = [
    "Pre-Operative Baseline", "Annual Physical Labs", "Follow-up Panel", "Pre-Surgery Panel",
    "Routine Blood Draw", "Comprehensive Blood Panel", "Evening Follow-up Panel", "Quarterly Monitoring", "New Year Baseline",
]

BLOOD_TEST_SUBTITLES = [
    "CBC, PT/PTT, Type & Screen", "CBC, CMP, Lipid Panel", "CBC, Basic Metabolic", "CBC, PT/PTT, Type & Screen",
    "CBC, Basic Metabolic", "CBC, CMP, Lipid Panel", "CBC, CMP, Lipid Panel", "CBC, CMP, Iron Panel, Lipid Panel", "CBC, CMP, Lipid Panel, Iron Panel, Thyroid, Vitamins",
]

BLOOD_TEST_CLINICS = [
    "CityLab Diagnostics", "Invitro Lab", "Invitro Lab", "CityLab Diagnostics",
    "Invitro Lab", "Invitro Lab", "Invitro Lab", "Invitro Lab", "CityLab Diagnostics",
]

BLOOD_ATTACHMENTS: dict[str, list[dict]] = {
    "blood-feb": [{"id": "feb-lab", "name": "PreOp_Lab_Report_Feb2026.pdf", "type": "Lab Report", "size": "312 KB"}],
    "blood-may": [{"id": "may-lab", "name": "Annual_Lab_Report_May2026.pdf", "type": "Lab Report", "size": "198 KB"}],
    "blood-jun": [{"id": "jun-lab", "name": "FollowUp_Lab_Report_Jun2026.pdf", "type": "Lab Report", "size": "176 KB"}],
    "blood-aug": [{"id": "aug-lab", "name": "PreSurgery_Lab_Report_Aug2026.pdf", "type": "Lab Report", "size": "284 KB"}],
    "blood-oct": [{"id": "r1", "name": "Lab_Report_Oct2026.pdf", "type": "Lab Report", "size": "245 KB"}],
    "blood-oct-eve": [{"id": "oct-eve-lab", "name": "Evening_Lab_Report_Oct2026.pdf", "type": "Lab Report", "size": "210 KB"}],
    "blood-dec": [{"id": "dec-lab", "name": "Quarterly_Lab_Report_Dec2026.pdf", "type": "Lab Report", "size": "220 KB"}],
    "blood-jan": [{"id": "jan-lab", "name": "NewYear_Baseline_Lab_Report_Jan2027.pdf", "type": "Lab Report", "size": "356 KB"}],
}

BIOMARKER_VALUES: dict[str, list[float]] = {
    "wbc": [5.2, 5.0, 15.8, 5.5, 6.8, 7.2, 7.0, 14.2, 6.1],
    "rbc": [4.3, 4.4, 4.4, 4.5, 4.7, 4.9, 4.8, 4.8, 4.7],
    "hb": [12.8, 13.0, 10.1, 13.5, 13.8, 14.2, 14.0, 14.0, 13.9],
    "hct": [38.5, 39.0, 39.8, 40.2, 41.5, 42.0, 41.5, 41.2, 40.8],
    "plt": [275, 268, 55, 260, 248, 255, 260, 250, 245],
    "glu": [88, 92, 185, 95, 88, 92, 88, 210, 90],
    "bun": [14, 15, 14, 15, 16, 18, 17, 17, 16],
    "cre": [0.8, 0.8, 2.1, 0.8, 0.8, 0.9, 0.9, 2.4, 1.1],
    "ldl": [155, 150, 148, 142, 125, 118, 115, 195, 112],
    "hdl": [42, 44, 46, 48, 52, 55, 56, 56, 58],
    "trig": [165, 160, 158, 155, 145, 132, 128, 130, 128],
    "iron": [65, 72, 22, 85, 78, 72, 70, 75, 78],
    "ferritin": [45, 40, 35, 31, 26, 22, 20, 8, 18],
    "tibc": [320, 335, 348, 356, 372, 388, 385, 395, 410],
    "tsh": [2.5, 2.3, 2.0, 1.8, 1.9, 2.1, 2.0, 2.0, 1.8],
    "t4": [1.0, 1.0, 1.1, 1.1, 1.1, 1.2, 1.2, 1.2, 1.3],
    "b12": [280, 295, 305, 310, 325, 340, 335, 360, 380],
    "d": [38, 36, 35, 35, 32, 28, 26, 12, 24],
}


def _build_biomarkers_for_date(date_idx: int) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for bid, values in BIOMARKER_VALUES.items():
        v = values[date_idx]
        defn = BIOMARKER_DEFINITIONS[bid]
        result[bid] = {
            "value": v,
            "status": _status(v, defn["reference"]),
        }
    return result


def _wrap_tx(text: str) -> dict:
    return {"original": text, "translated_en": text}


DOCTOR_VISITS: list[dict] = [
    {
        "id": "cardio",
        "type": "doctor_visit",
        "date": "2024-09-05",
        "title": "Cardiology Follow-up",
        "subtitle": "Dr. Elena Ivanova",
        "category": "Cardiology",
        "status": "Completed",
        "clinic": "Central Heart Institute",
        "attachments": [
            {"id": "consult", "name": "Consultation_Notes_Sep2024.pdf", "type": "Physician commentary", "size": "128 KB"},
            {"id": "ekg", "name": "EKG_Strip_Scan.pdf", "type": "Diagnostic image", "size": "2.1 MB"},
        ],
        "visit_data": {
            "specialty": "Cardiology Follow-up",
            "provider": "Dr. Elena Ivanova, MD",
            "date": "2024-09-05",
            "clinic": "Central Heart Institute",
            "verdict": _wrap_tx("Mild Sinus Tachycardia - Under Control. Patient responding well to current regimen."),
            "notes": [
                {"heading": "Chief Complaint & Subjective", "text_original": "Patient reports occasional palpitations during heavy exercise. Denies chest pain, shortness of breath, or dizziness. Mentions feeling generally fatigued in the mornings.", "text_translated": "Patient reports occasional palpitations during heavy exercise. Denies chest pain, shortness of breath, or dizziness. Mentions feeling generally fatigued in the mornings."},
                {"heading": None, "text_original": "Vitals taken at desk: BP 118/76, HR 88 bpm, O2 99%. Weight stable.", "text_translated": "Vitals taken at desk: BP 118/76, HR 88 bpm, O2 99%. Weight stable."},
                {"heading": "Objective Findings", "text_original": "Heart rhythm is regular. No murmurs, gallops, or rubs heard. Lungs are clear to auscultation bilaterally. EKG performed in-office reveals Normal Sinus Rhythm, rate 88, with no ST-T wave abnormalities.", "text_translated": "Heart rhythm is regular. No murmurs, gallops, or rubs heard. Lungs are clear to auscultation bilaterally. EKG performed in-office reveals Normal Sinus Rhythm, rate 88, with no ST-T wave abnormalities."},
            ],
            "prescriptions": [
                {"id": 1, "name": _wrap_tx("Metoprolol Succinate"), "dose": _wrap_tx("25mg"), "instruction": _wrap_tx("1 tablet daily (morning)")},
            ],
            "recommendations": [
                _wrap_tx("Schedule 6-month follow-up EKG and consultation."),
                _wrap_tx("Comprehensive Metabolic Panel (CMP) prior to next visit."),
            ],
        },
    },
    {
        "id": "ortho",
        "type": "doctor_visit",
        "date": "2024-08-22",
        "title": "Orthopedic Consultation",
        "subtitle": "Dr. James Mitchell, DO",
        "category": "Orthopedics",
        "status": "Completed",
        "clinic": "Northern Sports Medicine",
        "attachments": [],
        "visit_data": {
            "specialty": "Orthopedic Consultation",
            "provider": "Dr. James Mitchell, DO",
            "date": "2024-08-22",
            "clinic": "Northern Sports Medicine",
            "verdict": _wrap_tx("Left knee patellar tendinopathy (Jumper's Knee). MRI confirms mild tendinosis without tear."),
            "notes": [
                {"heading": "Chief Complaint", "text_original": "Left anterior knee pain for 3 months, worse with squatting and stairs. Patient is a recreational basketball player.", "text_translated": "Left anterior knee pain for 3 months, worse with squatting and stairs. Patient is a recreational basketball player."},
                {"heading": "Physical Exam", "text_original": "Tenderness over patellar tendon at tibial insertion. Pain with resisted knee extension. No effusion. Full range of motion.", "text_translated": "Tenderness over patellar tendon at tibial insertion. Pain with resisted knee extension. No effusion. Full range of motion."},
                {"heading": "Imaging Review", "text_original": "MRI left knee: Mild thickening and signal increase in proximal patellar tendon consistent with tendinosis. No tear.", "text_translated": "MRI left knee: Mild thickening and signal increase in proximal patellar tendon consistent with tendinosis. No tear."},
            ],
            "prescriptions": [
                {"id": 2, "name": _wrap_tx("Ibuprofen"), "dose": _wrap_tx("400mg"), "instruction": _wrap_tx("Take 1 tablet twice daily with food as needed for pain")},
            ],
            "recommendations": [
                _wrap_tx("Physical therapy 2x/week for 6 weeks focusing on eccentric quad strengthening."),
                _wrap_tx("Activity modification - avoid jumping and deep squatting for 4 weeks."),
                _wrap_tx("Follow-up in 8 weeks with repeat clinical assessment."),
            ],
        },
    },
    {
        "id": "neuro",
        "type": "doctor_visit",
        "date": "2024-10-18",
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
            "date": "2024-10-18",
            "clinic": "Neurology Associates",
            "verdict": _wrap_tx("Suspected Migraine with Brainstem Aura. MRI brain scheduled to rule out structural causes."),
            "notes": [
                {"heading": "Chief Complaint", "text_original": "Patient reports recurrent episodes of vertigo, blurred vision, and unilateral throbbing headache lasting 4-72 hours. Episodes increased in frequency over the past 2 months — now 3-4 per month.", "text_translated": "Patient reports recurrent episodes of vertigo, blurred vision, and unilateral throbbing headache lasting 4-72 hours. Episodes increased in frequency over the past 2 months — now 3-4 per month."},
                {"heading": None, "text_original": "Patient also notes photophobia, phonophobia, and occasional nausea during episodes. No aura prior to onset. Family history positive for migraines (mother).", "text_translated": "Patient also notes photophobia, phonophobia, and occasional nausea during episodes. No aura prior to onset. Family history positive for migraines (mother)."},
                {"heading": "Physical Exam", "text_original": "Cranial nerves II-XII intact. Motor strength 5/5 throughout. Sensation intact. Reflexes 2+ and symmetric. Coordination and gait normal. No papilledema on fundoscopy.", "text_translated": "Cranial nerves II-XII intact. Motor strength 5/5 throughout. Sensation intact. Reflexes 2+ and symmetric. Coordination and gait normal. No papilledema on fundoscopy."},
                {"heading": "Assessment", "text_original": "1. Migraine without aura (G43.0) — likely diagnosis. 2. Rule out brainstem pathology with MRI. 3. Consider starting prophylactic therapy if frequency exceeds 4/month.", "text_translated": "1. Migraine without aura (G43.0) — likely diagnosis. 2. Rule out brainstem pathology with MRI. 3. Consider starting prophylactic therapy if frequency exceeds 4/month."},
            ],
            "prescriptions": [
                {"id": 3, "name": _wrap_tx("Sumatriptan Succinate"), "dose": _wrap_tx("50mg"), "instruction": _wrap_tx("Take 1 tablet at onset of migraine; may repeat once after 2 hours if no relief (max 2/day)")},
                {"id": 4, "name": _wrap_tx("Vitamin B2 (Riboflavin)"), "dose": _wrap_tx("400mg"), "instruction": _wrap_tx("1 tablet daily for migraine prophylaxis")},
            ],
            "recommendations": [
                _wrap_tx("MRI brain with and without contrast to rule out structural causes."),
                _wrap_tx("Keep headache diary for 8 weeks tracking triggers, frequency, and severity."),
                _wrap_tx("Follow-up in 4 weeks to review MRI results and assess response to Sumatriptan."),
                _wrap_tx("Consider neurology referral if symptoms worsen or atypical features develop."),
            ],
        },
    },
]

PROCEDURES: list[dict] = [
    {
        "id": "derm",
        "type": "procedure",
        "date": "2024-09-12",
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


def seed_test_db(db) -> None:
    # Create test user if not exists
    if not db.query(Patient).filter(Patient.id == TEST_USER_ID).first():
        db.add(Patient(
            id=TEST_USER_ID,
            email=TEST_USER_EMAIL,
            hashed_password=hash_password(TEST_USER_PASSWORD),
            name="Test User",
            dob="1990-01-01",
            gender="Other",
            external_id="HP-TEST-0001",
        ))
        db.flush()

    existing_defs = {r.id for r in db.query(BiomarkerDefinition.id).all()}
    for bid, defn in BIOMARKER_DEFINITIONS.items():
        if bid not in existing_defs:
            db.add(BiomarkerDefinition(
                id=bid,
                loinc_code=defn.get("loinc_code"),
                names=defn["names"],
                synonyms=defn.get("synonyms"),
                category=defn["category"],
                reference=defn["reference"],
                unit=defn["unit"],
                scope=defn.get("scope", "global"),
                user_id=defn.get("user_id"),
                reference_source="global",
            ))
    db.flush()

    existing_entries = {r.id for r in db.query(MedicalEntry.id).all()}
    for i, eid in enumerate(BLOOD_TEST_IDS):
        if eid in existing_entries:
            continue
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
        entry = MedicalEntry(
            id=eid,
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=datetime.fromisoformat(BLOOD_TEST_DATES[i]).replace(tzinfo=timezone.utc),
            title=BLOOD_TEST_TITLES[i],
            subtitle=BLOOD_TEST_SUBTITLES[i],
            category="Labs",
            status="Completed",
            clinic=BLOOD_TEST_CLINICS[i],
        )
        db.add(entry)
        db.flush()
        for bid, bdata in biomarkers.items():
            db.add(BiomarkerReading(
                entry_id=eid,
                biomarker_id=bid,
                value=bdata["value"],
                reference=BIOMARKER_DEFINITIONS[bid]["reference"],
                status=bdata["status"],
            ))
        for att in BLOOD_ATTACHMENTS.get(eid, []):
            db.add(Attachment(
                id=att["id"],
                entry_id=eid,
                name=att["name"],
                type=att["type"],
                size=att["size"],
            ))
    db.flush()

    for vd in DOCTOR_VISITS:
        eid = vd["id"]
        if eid in existing_entries:
            continue
        entry = MedicalEntry(
            id=eid,
            patient_id=TEST_USER_ID,
            type="doctor_visit",
            date=datetime.fromisoformat(vd["date"]).replace(tzinfo=timezone.utc),
            title=vd["title"],
            subtitle=vd["subtitle"],
            category=vd["category"],
            status=vd.get("status", "Completed"),
            clinic=vd["clinic"],
        )
        db.add(entry)
        db.flush()
        for att in vd["attachments"]:
            db.add(Attachment(
                id=att["id"],
                entry_id=eid,
                name=att["name"],
                type=att["type"],
                size=att["size"],
            ))
        v = vd["visit_data"]
        db.add(VisitData(
            entry_id=eid,
            specialty=v["specialty"],
            provider=v["provider"],
            date=datetime.fromisoformat(v["date"]).replace(tzinfo=timezone.utc),
            clinic=v["clinic"],
            verdict=v["verdict"],
            notes=v["notes"],
            prescriptions=v["prescriptions"],
            recommendations=v["recommendations"],
        ))
    db.flush()

    for proc in PROCEDURES:
        eid = proc["id"]
        if eid in existing_entries:
            continue
        entry = MedicalEntry(
            id=eid,
            patient_id=TEST_USER_ID,
            type=proc["type"],
            date=datetime.fromisoformat(proc["date"]).replace(tzinfo=timezone.utc),
            title=proc["title"],
            subtitle=proc["subtitle"],
            category=proc["category"],
            status=proc.get("status", "Completed"),
            clinic=proc["clinic"],
        )
        db.add(entry)
        db.flush()
        for att in proc["attachments"]:
            db.add(Attachment(
                id=att["id"],
                entry_id=eid,
                name=att["name"],
                type=att["type"],
                size=att["size"],
            ))
    db.flush()
    db.commit()
