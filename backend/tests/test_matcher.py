"""Matcher tests: correct resolution of localized names and the guard that
prevents ungrounded LLM guesses from polluting the shared global dictionary."""

import json

from app.db.models import BiomarkerDefinition
from app.db.session import SessionLocal
from app.schemas.ai import RawBiomarker, RawMedicalRecord
from app.services import matcher


class _FakeMsg:
    def __init__(self, content):
        self.content = content


class _FakeResp:
    def __init__(self, payload: dict):
        # Mirror the real client: message.content is a JSON string that the
        # matcher parses into LoincGuessBatch / TranslationBatch.
        self.choices = [type("Choice", (), {"message": _FakeMsg(json.dumps(payload))})]


class _ScriptedClient:
    """LLM that always 'guesses' Calcium (17861-6) for any unmatched name and
    returns a fixed English translation per raw name."""

    GUESS_LOINC = "17861-6"  # Calcium — the wrong mapping in the original bug

    def __init__(self, translations: dict[str, str]):
        self.translations = translations

    @property
    def chat(self):
        test = self

        class _Chat:
            def parse(self, **kw):
                system = kw["messages"][0]["content"]
                if "translator" in system:
                    guesses = [
                        {"raw_name": n, "standard_name_en": test.translations.get(n, n)}
                        for n in test.translations
                    ]
                    return _FakeResp({"guesses": guesses})
                if "LOINC code" in system:
                    return _FakeResp(
                        {
                            "guesses": [
                                {
                                    "raw_name": n,
                                    "standard_name_en": test.translations.get(n, n),
                                    "guessed_loinc": test.GUESS_LOINC,
                                }
                                for n in test.translations
                            ]
                        }
                    )
                return _FakeResp({"guesses": []})

        return _Chat()


def _global_defs(db):
    defs = db.query(BiomarkerDefinition).filter_by(scope="global").all()
    for d in defs:
        db.expunge(d)
    return defs


def test_russian_name_resolves_via_multilingual_table():
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        raw = RawMedicalRecord(
            entry_type="blood_test",
            biomarkers=[RawBiomarker(name="Билирубин общий", value="15", unit="мкмоль/л")],
        )
        # No LLM at all — the curated table must resolve it.
        res = matcher.match_and_convert(raw, defs, db, "u_ml", client=None)
        b = res.biomarkers[0]
        assert b.definition_id == "1975-2", b.definition_id
        assert b.scope == "global"
        assert b.standard_name_en == "Bilirubin"
    finally:
        db.close()


def test_ungrounded_llm_guess_stays_local_not_global():
    """Reproduces the original bug: an ungrounded LLM guess of Calcium for a
    name that matches nothing must NOT touch the global Calcium definition."""
    db = SessionLocal()
    global_before = db.query(BiomarkerDefinition).filter_by(scope="global").count()
    try:
        defs = _global_defs(db)
        raw = RawMedicalRecord(
            entry_type="blood_test",
            biomarkers=[RawBiomarker(name="zzqwkj vmxptlk", value="1", unit="")],
        )
        client = _ScriptedClient({"zzqwkj vmxptlk": "zzqwkj vmxptlk"})
        res = matcher.match_and_convert(raw, defs, db, "u_local", client)
        b = res.biomarkers[0]
        assert b.scope == "local", b.scope
        assert b.definition_id.startswith("local-"), b.definition_id
        # The shared global dictionary is untouched.
        assert db.query(BiomarkerDefinition).filter_by(scope="global").count() == global_before
        calcium = db.query(BiomarkerDefinition).filter_by(
            loinc_code="17861-6", scope="global"
        ).first()
        assert not any("zzqwkj" in s.lower() for s in (calcium.synonyms or []))
    finally:
        db.close()


def test_grounded_translated_name_can_match_global():
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        raw = RawMedicalRecord(
            entry_type="blood_test",
            biomarkers=[RawBiomarker(name="Глюкоза натощак", value="5.5", unit="mmol/L")],
        )
        # Translator returns a close English name; fuzzy match must ground it.
        client = _ScriptedClient({"Глюкоза натощак": "Glucose fasting"})
        res = matcher.match_and_convert(raw, defs, db, "u_glu", client)
        b = res.biomarkers[0]
        assert b.scope == "global"
        assert b.definition_id == "2345-7"  # Glucose
    finally:
        db.close()


def test_fuzzy_guard_blocks_cross_analyte():
    """ESR must never fuzzy-match Erythrocytes/Creatinine on shared substrings."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        index = matcher.build_name_index(defs)
        # "ESR" now resolves to the real ESR definition, never to Erythrocytes.
        esr = matcher.fuzzy_match("ESR", index)
        assert esr is not None and esr.loinc_code == "4537-7"
        # The long form must not misroute to Erythrocytes (789-8) or Creatinine.
        long_form = matcher.fuzzy_match("Erythrocyte sedimentation rate", index)
        assert long_form is None or long_form.loinc_code == "4537-7"
        # Legit qualifier matches still work.
        assert matcher.fuzzy_match("Total bilirubin", index).loinc_code == "1975-2"
        assert matcher.fuzzy_match("Glucose fasting", index).loinc_code == "2345-7"
    finally:
        db.close()


def test_multilingual_table_resolves_wbc_and_esr():
    """СОЭ and Эозинофилы must resolve to ESR/Eosinophils, not Erythrocytes."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        raw = RawMedicalRecord(
            entry_type="blood_test",
            biomarkers=[
                RawBiomarker(name="СОЭ", value="12", unit="мм/ч", raw_range_string="2 - 15"),
                RawBiomarker(name="Эозинофилы", value="3", unit="%", raw_range_string="1 - 5"),
            ],
        )
        res = matcher.match_and_convert(raw, defs, db, "u_cbc", client=None)
        by_name = {b.raw_name: b for b in res.biomarkers}
        # СОЭ resolves to ESR (not the mis-truncated "Erythrocyte").
        assert by_name["СОЭ"].standard_name_en == "ESR"
        assert by_name["СОЭ"].scope == "global"
        # Unit is "%" -> the fraction variant is selected (not plain "Eosinophils",
        # and certainly not "Erythrocytes").
        assert by_name["Эозинофилы"].standard_name_en == "Eosinophils, %"
    finally:
        db.rollback()
        db.close()


def test_neutrophil_subtypes_stay_distinct():
    """Band vs. segmented neutrophils must map to separate definitions and keep
    their subtype in the display name (no collapse to a generic 'Neutrophils')."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        raw = RawMedicalRecord(
            entry_type="blood_test",
            biomarkers=[
                RawBiomarker(
                    name="Палочкоядерные нейтрофилы", value="3", unit="%",
                    raw_range_string="1 - 6",
                ),
                RawBiomarker(
                    name="Сегментоядерные нейтрофилы", value="55", unit="%",
                    raw_range_string="47 - 72",
                ),
            ],
        )
        res = matcher.match_and_convert(raw, defs, db, "u_neut", client=None)
        by_name = {b.raw_name: b for b in res.biomarkers}
        band = by_name["Палочкоядерные нейтрофилы"]
        seg = by_name["Сегментоядерные нейтрофилы"]
        assert band.standard_name_en == "Band Neutrophils, %"
        assert seg.standard_name_en == "Segmented Neutrophils, %"
        assert band.definition_id != seg.definition_id
    finally:
        db.rollback()
        db.close()


def test_hematocrit_named_correctly():
    """Гематокрит must resolve to 'Hematocrit', not the mis-truncated component."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        raw = RawMedicalRecord(
            entry_type="blood_test",
            biomarkers=[
                RawBiomarker(name="Гематокрит", value="42", unit="%", raw_range_string="39 - 49"),
            ],
        )
        res = matcher.match_and_convert(raw, defs, db, "u_hct", client=None)
        b = res.biomarkers[0]
        assert b.standard_name_en == "Hematocrit"
        assert b.scope == "global"
    finally:
        db.rollback()
        db.close()


def test_document_range_first_keeps_doc_units():
    """Cyrillic-unit values with a document range keep their own unit + range
    and are evaluated like-for-like (no false out-of-range)."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        raw = RawMedicalRecord(
            entry_type="blood_test",
            biomarkers=[
                RawBiomarker(
                    name="Глюкоза", value="5.5", unit="ммоль/л", raw_range_string="3.9 - 6.1"
                ),
            ],
        )
        res = matcher.match_and_convert(raw, defs, db, "u_docrange", client=None)
        b = res.biomarkers[0]
        assert b.standard_value == 5.5
        assert b.standard_unit == "mmol/L"  # normalized, not converted to mg/dL
        assert b.reference.kind == "interval"
        assert b.reference.low == 3.9
        assert b.reference.high == 6.1
        assert b.status == "normal"
        # A recognized analyte stays global even when we display the lab's range.
        assert b.scope == "global"
    finally:
        db.rollback()
        db.close()


def test_normoblasts_distinct_from_erythrocytes():
    """Нормобласты (nucleated RBC) must not collapse into plain Erythrocytes."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        raw = RawMedicalRecord(
            entry_type="blood_test",
            biomarkers=[
                RawBiomarker(name="Эритроциты", value="4.5", unit="10*12/л",
                             raw_range_string="3.9 - 5.1"),
                RawBiomarker(name="Нормобласты", value="2", unit="%", raw_range_string="0 - 1"),
            ],
        )
        res = matcher.match_and_convert(raw, defs, db, "u_nb", client=None)
        by_name = {b.raw_name: b for b in res.biomarkers}
        assert by_name["Эритроциты"].standard_name_en == "Erythrocytes"
        nb = by_name["Нормобласты"]
        # Unit is "%" -> fraction variant; still distinct from plain Erythrocytes.
        assert nb.standard_name_en == "Nucleated Erythrocytes, %"
        assert nb.definition_id != by_name["Эритроциты"].definition_id
    finally:
        db.rollback()
        db.close()


def test_direct_indirect_bilirubin_are_distinct():
    """Direct/indirect bilirubin resolve to separate serum definitions."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        raw = RawMedicalRecord(
            entry_type="blood_test",
            biomarkers=[
                RawBiomarker(name="Билирубин прямой", value="3.4", unit="мкмоль/л",
                             raw_range_string="0 - 5.1"),
                RawBiomarker(name="Билирубин непрямой", value="10", unit="мкмоль/л",
                             raw_range_string="0 - 16"),
            ],
        )
        res = matcher.match_and_convert(raw, defs, db, "u_bili", client=None)
        by_name = {b.raw_name: b for b in res.biomarkers}
        assert by_name["Билирубин прямой"].standard_name_en == "Direct Bilirubin"
        assert by_name["Билирубин непрямой"].standard_name_en == "Indirect Bilirubin"
    finally:
        db.rollback()
        db.close()


def test_percent_unit_routes_to_fraction_variant():
    """A % unit must resolve to the '… %' (fraction) variant, not the absolute code;
    an absolute unit must NOT get a '%' suffix."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        cases = [
            # (raw_name, unit, expected_name, expected_loinc)
            ("Эозинофилы, %", "%", "Eosinophils, %", "713-8"),
            ("Эозинофилы, абс.", "10*9/л", "Eosinophils", "711-2"),
            ("Эозинофилы", "10*9/л", "Eosinophils", "711-2"),
            ("Нейтрофилы, %", "%", "Neutrophils, %", "770-8"),
            ("Нейтрофилы", "10*9/л", "Neutrophils", "751-8"),
        ]
        for raw_name, unit, exp_name, exp_loinc in cases:
            raw = RawMedicalRecord(
                entry_type="blood_test",
                biomarkers=[RawBiomarker(name=raw_name, value="3", unit=unit,
                                         raw_range_string="1 - 5")],
            )
            res = matcher.match_and_convert(raw, defs, db, "u_pct", client=None)
            b = res.biomarkers[0]
            assert b.standard_name_en == exp_name, (raw_name, b.standard_name_en)
            assert b.definition_id == exp_loinc, (raw_name, b.definition_id)
    finally:
        db.rollback()
        db.close()


class _VerifyClient:
    """Scripted LLM whose verification pass returns fixed judgements per raw_name."""

    def __init__(self, verdicts: dict[str, dict]):
        # verdicts: raw_name -> {"agree": bool, "corrected_name_en"/"corrected_loinc"}
        self.verdicts = verdicts

    @property
    def chat(self):
        test = self

        class _Chat:
            def parse(self, **kw):
                verifications = [
                    {"raw_name": n, **v} for n, v in test.verdicts.items()
                ]
                payload = {"verifications": verifications}
                content = json.dumps(payload)
                msg = type("Msg", (), {"content": content})
                choice = type("Choice", (), {"message": msg})
                return type("Resp", (), {"choices": [choice]})

        return _Chat()


def test_verifier_corrects_when_grounded():
    """A rejected match is replaced only by a correction that grounds to a real def."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        index = matcher.build_name_index(defs)
        potassium = next(d for d in defs if d.loinc_code == "2823-3")
        next(d for d in defs if d.loinc_code == "789-8")
        b = RawBiomarker(name="Эритроциты", value="4.5", unit="10*12/L")
        client = _VerifyClient(
            {"Эритроциты": {"agree": False, "corrected_loinc": "789-8"}}
        )
        kept, rejected = matcher._verify_and_correct(
            [(b, potassium)], index, db, client
        )
        assert rejected == []
        assert len(kept) == 1
        assert kept[0][1].loinc_code == "789-8"
    finally:
        db.rollback()
        db.close()


def test_verifier_rejects_when_ungrounded():
    """A disagreement with no groundable correction drops the match (not shown wrong)."""
    db = SessionLocal()
    try:
        defs = _global_defs(db)
        index = matcher.build_name_index(defs)
        potassium = next(d for d in defs if d.loinc_code == "2823-3")
        b = RawBiomarker(name="Эритроциты", value="4.5", unit="10*12/L")
        client = _VerifyClient(
            {"Эритроциты": {"agree": False, "corrected_name_en": "Zzqq nonexistent analyte"}}
        )
        kept, rejected = matcher._verify_and_correct(
            [(b, potassium)], index, db, client
        )
        assert kept == []
        assert len(rejected) == 1 and rejected[0].name == "Эритроциты"
    finally:
        db.rollback()
        db.close()
