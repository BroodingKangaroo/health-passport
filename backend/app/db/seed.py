from app.db.models import (
    Patient,
    BiomarkerDefinition,
    MedicalEntry,
    BiomarkerReading,
    Attachment,
    VisitData,
)
from app.mock_db import (
    BIOMARKER_DEFINITIONS,
    BLOOD_TEST_IDS,
    BLOOD_TEST_DATES,
    BLOOD_TEST_TITLES,
    BLOOD_TEST_SUBTITLES,
    BLOOD_TEST_CLINICS,
    BLOOD_ATTACHMENTS,
    _build_biomarkers_for_date,
)

DEFAULT_PATIENT_ID = "default"


def _seed_patient(db) -> None:
    if db.query(Patient).filter(Patient.id == DEFAULT_PATIENT_ID).first():
        return
    db.add(Patient(
        id=DEFAULT_PATIENT_ID,
        name="Alexey Ivanov",
        dob="1988-03-14",
        gender="Male",
        external_id="HP-2026-04417",
    ))
    db.flush()


def _seed_biomarker_definitions(db) -> None:
    existing = {r.id for r in db.query(BiomarkerDefinition.id).all()}
    for bid, defn in BIOMARKER_DEFINITIONS.items():
        if bid not in existing:
            db.add(BiomarkerDefinition(
                id=bid,
                name_en=defn["name_en"],
                name_ru=defn["name_ru"],
                category=defn["category"],
                range_min=defn["range_min"],
                range_max=defn["range_max"],
                unit=defn["unit"],
            ))
    db.flush()


def _seed_blood_tests(db) -> None:
    existing = {r.id for r in db.query(MedicalEntry.id).all()}
    for i, eid in enumerate(BLOOD_TEST_IDS):
        if eid in existing:
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
            patient_id=DEFAULT_PATIENT_ID,
            type="blood_test",
            date=BLOOD_TEST_DATES[i],
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


def _seed_doctor_visits(db) -> None:
    existing = {r.id for r in db.query(MedicalEntry.id).all()}

    visits_data = [
        {
            "id": "cardio",
            "date": "Sep 05, 2026",
            "title": "Cardiology Follow-up",
            "subtitle": "Dr. Elena Ivanova",
            "category": "Cardiology",
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
            "date": "Aug 22, 2026",
            "title": "Orthopedic Consultation",
            "subtitle": "Dr. James Mitchell, DO",
            "category": "Orthopedics",
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
            "date": "Oct 18, 2026",
            "title": "Neurology Assessment",
            "subtitle": "Dr. S. Reynolds, MD, PhD",
            "category": "Neurology",
            "clinic": "Neurology Associates",
            "status": "Scheduled",
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

    for vd in visits_data:
        eid = vd["id"]
        if eid in existing:
            continue
        entry = MedicalEntry(
            id=eid,
            patient_id=DEFAULT_PATIENT_ID,
            type="doctor_visit",
            date=vd["date"],
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
            date=v["date"],
            clinic=v["clinic"],
            verdict=v["verdict"],
            notes=v["notes"],
            prescriptions=v["prescriptions"],
            recommendations=v["recommendations"],
        ))
    db.flush()


def _seed_procedure(db) -> None:
    existing = {r.id for r in db.query(MedicalEntry.id).all()}
    if "derm" in existing:
        return
    entry = MedicalEntry(
        id="derm",
        patient_id=DEFAULT_PATIENT_ID,
        type="procedure",
        date="Sep 12, 2026",
        title="Skin Biopsy",
        subtitle="Left upper arm",
        category="Dermatology",
        status="Completed",
        clinic="Dermatology Clinic",
    )
    db.add(entry)
    db.flush()
    db.add(Attachment(
        id="path",
        entry_id="derm",
        name="Pathology_Report.pdf",
        type="Pathology",
        size="890 KB",
    ))
    db.flush()


def seed_db(db) -> None:
    _seed_patient(db)
    _seed_biomarker_definitions(db)
    _seed_blood_tests(db)
    _seed_doctor_visits(db)
    _seed_procedure(db)
    db.commit()
