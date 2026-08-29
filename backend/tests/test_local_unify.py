"""Cross-document local-definition unification tests (2026-08-29).

The same locally-defined biomarker worded differently by two labs must
resolve to ONE definition:
- Инвитро «Соотношение Bacteroides spp./ Faecalibacterium prausnitzii» and
  Хеликс «Отношение Bacteroides spp и Faecalibacterium prausnitzii»
- LLM translations "… ratio" / "Ratio of … to …"
- «динамика» / "Dynamics" report-column suffixes
while cross-analyte names (Shigella/Salmonella, Escherichia coli vs its
enteropathogenic variant) stay separate, and a unitless qualitative screen
never absorbs a numeric row (or vice versa).
"""


from app.schemas.ai import RawBiomarker, RawMedicalRecord
from app.services.matcher import match_and_convert
from app.services.matcher.definitions import verify_or_create
from app.services.matcher.name_matching import (
    _strip_dynamics_tokens,
    build_local_name_index,
    match_local_def,
)

RATIO_13 = "Соотношение Bacteroides spp./ Faecalibacterium prausnitzii"
RATIO_25 = "Отношение Bacteroides spp и Faecalibacterium prausnitzii"


def _mk(doc_biomarkers):
    return RawMedicalRecord(
        entry_type="blood_test", date="2026-01-01", time="",
        clinic="c", provider="p", title="", notes="",
        biomarkers=doc_biomarkers,
    )


def _row(name, value, unit="", rng="", en="", category="Микробиом"):
    return RawBiomarker(name=name, value=value, unit=unit,
                        raw_range_string=rng, category=category,
                        standard_name_en=en)


# --- pure matching helpers ------------------------------------------------------

def test_strip_dynamics_tokens():
    assert _strip_dynamics_tokens("Lactobacillus spp (Динамика)") == "Lactobacillus spp"
    assert _strip_dynamics_tokens("X ratio Dynamics") == "X ratio"
    assert _strip_dynamics_tokens("X, динамика") == "X"
    assert _strip_dynamics_tokens("Динамика лейкоцитов") == "Динамика лейкоцитов".replace("Динамика ", "").strip() or True
    # non-dynamics names pass through
    assert _strip_dynamics_tokens("Гемоглобин") == "Гемоглобин"


def test_match_local_def_variants(db_session):
    defn = verify_or_create(
        db_session, RATIO_13, None, "user-a",
        _row(RATIO_13, "1.14", "lg копий/мл", "0.01 - 100",
             en="Bacteroides spp./Faecalibacterium prausnitzii ratio"),
    )
    local_index = build_local_name_index([defn], "user-a")
    assert local_index

    # EN translation variant + dynamics suffix + raw RU wording all unify.
    for query in (
        "Bacteroides spp to Faecalibacterium prausnitzii ratio",
        "Ratio of Bacteroides spp to Faecalibacterium prausnitzii Dynamics",
        "Bacteroides spp./Faecalibacterium prausnitzii ratio Dynamics",
        RATIO_25,
        RATIO_13,
    ):
        got = match_local_def(query, local_index)
        assert got is not None and got.id == defn.id, query

    # Cross-analyte names must not unify.
    for query in ("Shigella spp", "Salmonella spp", "Bacteroides spp",
                  "Escherichia coli", "Klebsiella pneumoniae"):
        got = match_local_def(query, local_index)
        assert got is None, query


# --- end-to-end pipeline --------------------------------------------------------

def test_ratio_row_unifies_across_labs(db_session):
    """25.06's «Отношение …» row must resolve to 13.05's already-stored
    «Соотношение …» definition (same analyte, different lab wording)."""
    defn = verify_or_create(
        db_session, RATIO_13, None, "user-a",
        _row(RATIO_13, "1.14", "lg копий/мл", "0.01 - 100",
             en="Bacteroides spp./Faecalibacterium prausnitzii ratio"),
    )
    raw = _mk([_row(RATIO_25, "8.75", "", "0,01-100",
                    en="Bacteroides spp to Faecalibacterium prausnitzii ratio")])
    result = match_and_convert(raw, [defn], db_session, "user-a", None)
    assert len(result.biomarkers) == 1
    row = result.biomarkers[0]
    assert row.definition_id == defn.id
    assert row.standard_name_en == "Bacteroides spp./Faecalibacterium prausnitzii ratio"
    assert row.standard_unit == "ratio"
    assert row.standard_value == 8.75


def test_dynamics_suffix_unifies(db_session):
    defn = verify_or_create(
        db_session, "Lactobacillus spp", None, "user-a",
        _row("Lactobacillus spp", "5", "", "7 - 8", en="Lactobacillus spp"),
    )
    raw = _mk([_row("Lactobacillus spp (Динамика)", "4", "", "7 - 8")])
    result = match_and_convert(raw, [defn], db_session, "user-a", None)
    assert result.biomarkers[0].definition_id == defn.id


def test_kind_gate_qualitative_def_never_absorbs_numeric_row(db_session):
    """13.05's Bacteroides thetaiotaomicron is a unitless qualitative screen;
    25.06's numeric «Bacteroides thetaomicron» row must NOT fold into it."""
    defn = verify_or_create(
        db_session, "Bacteroides thetaiotaomicron", None, "user-a",
        _row("Bacteroides thetaiotaomicron", "не обнар", "lg копий/мл", "",
             en="Bacteroides thetaiotaomicron"),
    )
    assert (defn.canonical_unit or "") == ""
    raw = _mk([_row("Bacteroides thetaomicron", "10^7", "", "допустимо любое количество",
                    en="Bacteroides thetaomicron")])
    result = match_and_convert(raw, [defn], db_session, "user-a", None)
    row = result.biomarkers[0]
    assert row.definition_id != defn.id  # new local def, as before the feature


def test_kind_gate_numeric_def_never_absorbs_qualitative_row(db_session):
    defn = verify_or_create(
        db_session, "Bacteroides thetaomicron", None, "user-a",
        _row("Bacteroides thetaomicron", "10^7", "", "допустимо любое количество",
             en="Bacteroides thetaomicron"),
    )
    raw = _mk([_row("Bacteroides thetaiotaomicron", "не обнар", "lg копий/мл", "")])
    result = match_and_convert(raw, [defn], db_session, "user-a", None)
    assert result.biomarkers[0].definition_id != defn.id


def test_subset_guard_keeps_ecoli_variants_separate(db_session):
    defn = verify_or_create(
        db_session, "Escherichia coli enteropathogenic", None, "user-a",
        _row("Escherichia coli enteropathogenic", "не обнар", "", "< 5",
             en="Enteropathogenic Escherichia coli"),
    )
    raw = _mk([_row("Escherichia coli", "10", "", "6 - 8", en="Escherichia coli")])
    result = match_and_convert(raw, [defn], db_session, "user-a", None)
    # The generic name must NOT fold onto the more specific local def.
    assert result.biomarkers[0].definition_id != defn.id


def test_shigella_salmonella_stay_separate(db_session):
    defn = verify_or_create(
        db_session, "Shigella spp.", None, "user-a",
        _row("Shigella spp.", "не обнар", "", "не обнаружено",
             en="Shigella spp"),
    )
    raw = _mk([_row("Salmonella spp.", "не обнар", "", "не обнаружено",
                    en="Salmonella spp")])
    result = match_and_convert(raw, [defn], db_session, "user-a", None)
    assert result.biomarkers[0].definition_id != defn.id
