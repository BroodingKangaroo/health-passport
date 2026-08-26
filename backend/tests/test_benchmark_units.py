"""Offline unit tests for the extraction benchmark helpers (metrics wrapper,
scoring diff-grouping and aggregation). No network, no app imports needed
for scoring; metrics tests use a fake Mistral-shaped client."""

import math
from types import SimpleNamespace

from benchmark.metrics import BenchmarkMetrics, InstrumentedMistral
from benchmark.scoring import aggregate, case_scores, golden_items, group_diffs

# ---------------------------------------------------------------- metrics ---

class _FakeChat:
    def __init__(self):
        self.calls = 0

    def parse(self, **kwargs):
        self.calls += 1
        return SimpleNamespace(
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15)
        )


class _FakeFiles:
    def upload(self, file=None, **kwargs):
        return SimpleNamespace(id="file-1")


class _FakeOcr:
    def process(self, **kwargs):
        return SimpleNamespace(
            pages=[SimpleNamespace(markdown="page")],
            usage_info=SimpleNamespace(pages_processed=2, doc_size_bytes=4321),
        )


class _FakeMistral:
    def __init__(self):
        self.chat = _FakeChat()
        self.files = _FakeFiles()
        self.ocr = _FakeOcr()

    def models_list(self):  # arbitrary passthrough surface
        return "passthrough"


def test_instrumented_client_counts_llm_tokens_bytes_and_pages():
    fake = _FakeMistral()
    m = BenchmarkMetrics()
    wrapped = InstrumentedMistral(fake, m)

    wrapped.files.upload(file=SimpleNamespace(content=b"x" * 123))
    wrapped.ocr.process(model="mistral-ocr-latest")
    wrapped.chat.parse(model="mistral-large-latest")

    assert m.llm_calls == 1
    assert m.prompt_tokens == 10
    assert m.completion_tokens == 5
    assert m.llm_latency_s >= 0
    assert m.upload_bytes == 123
    assert m.uploads == 1
    assert m.ocr_pages == 2
    assert m.ocr_doc_bytes == 4321
    d = m.to_dict()
    assert d["input_tokens"] == 10 and d["output_tokens"] == 5

    other = BenchmarkMetrics()
    w2 = InstrumentedMistral(fake, other)
    w2.chat.parse()
    assert other.llm_calls == 1 and fake.chat.calls == 2


def test_metrics_merge_accumulates():
    a, b = BenchmarkMetrics(), BenchmarkMetrics()
    a.add_llm_call(3, 2, 0.1)
    b.add_llm_call(7, 8, 0.2)
    b.add_upload(9)
    a.merge(b)
    assert a.prompt_tokens == 10 and a.completion_tokens == 10
    assert a.upload_bytes == 9 and math.isclose(a.llm_latency_s, 0.3001, rel_tol=0.01)


def test_delegation_passes_through_unknown_attrs():
    fake = _FakeMistral()
    wrapped = InstrumentedMistral(fake, BenchmarkMetrics())
    assert wrapped.models_list() == "passthrough"


# ---------------------------------------------------------------- scoring ---

GOLDEN = {
    "biomarkers": [
        {"raw_name": "Hemoglobin", "standard_name_en": "Hemoglobin"},
        {"raw_name": "Glucose", "standard_name_en": "Glucose"},
        {"raw_name": "CRP", "standard_name_en": "C-reactive protein"},
    ],
    "visit_data": {
        "diagnosis": {"original": "Гастрит", "translated_en": "Gastritis"},
        "prescriptions": [{"name": {"original": "Nolpaza"}}],
        "recommendations": ["Rec one"],
    },
    "instrumental_data": {"findings": "Some findings"},
}


def test_universe_shape():
    items = golden_items(GOLDEN)
    assert items == {
        "bm:Hemoglobin", "bm:Glucose", "bm:CRP",
        "visit:diagnosis", "visit:rx:0", "visit:rec:0",
        "instr:findings",
    }


def test_perfect_run_scores_one():
    res = case_scores(GOLDEN, [[]])  # no diffs at all
    assert res["recognition"] == 1.0
    assert res["stability"] == 1.0


def test_missing_biomarker_penalizes_only_that_item():
    diffs = ["biomarker 'Glucose': MISSING in observed output"]
    # universe of 7, 1 missing → 6/7
    rec = case_scores(GOLDEN, [diffs])["recognition"]
    assert math.isclose(rec, 6 / 7, rel_tol=1e-9)


def test_value_diff_grouped_by_name_with_index_suffix():
    diffs = [
        "biomarker 'Гемоглобин'[0] standard_name_en: expected 'Hemoglobin', got 'Haemoglobin'",
        "biomarker \"it's\"[1] reference.kind: expected 'interval', got 'qualitative'",
    ]
    universe = {"bm:Гемоглобин", "bm:it's"}
    g = group_diffs(diffs, universe)
    assert g.bad == universe
    assert not g.extras
    assert not g.unclassified

    # Defensive path: a parsed detail name OUTSIDE the golden universe can't
    # be attributed to any golden item — it costs an extra instead.
    g2 = group_diffs(diffs, set())
    assert not g2.bad and g2.extras == len(diffs)


def test_unexpected_counts_as_extra_not_bad_item():
    diffs = ["biomarker 'Mystery analyte': UNEXPECTED in observed output (not in golden)"]
    grouped = group_diffs(diffs, golden_items(GOLDEN))
    assert grouped.extras == 1 and not grouped.bad


def test_extras_discount_applied():
    universe = golden_items(GOLDEN)
    base = case_scores(GOLDEN, [[]])
    with_extra = case_scores(
        GOLDEN,
        [["biomarker 'X y z': UNEXPECTED in observed output (not in golden)"]],
    )
    expected = max(0.0, min(1.0, (len(universe) - 0.5) / len(universe)))
    assert math.isclose(with_extra["recognition"], expected, rel_tol=1e-9)
    assert with_extra["recognition"] < base["recognition"]


def test_visit_indexed_and_count_mismatch_paths():
    diffs = [
        "visit_data.diagnosis.original: expected 'A', got 'B'",
        "visit_data.prescriptions[0].dosage: similarity 0.10 < 0.90 (expected 'мг', got 'mg!')",
        "visit_data.prescriptions: count mismatch golden=1 observed=3",
    ]
    g = group_diffs(diffs, golden_items(GOLDEN))
    assert g.bad >= {"visit:diagnosis", "visit:rx:0"}
    assert g.extras == abs(3 - 1)


def test_recommendation_and_instrumental_paths():
    diffs = [
        "visit_data.recommendations[0].translated_en: similarity 0.11 < 0.90",
        "instrumental_data.findings: similarity 0.42 < 0.90 (expected 'X', got 'Y')",
    ]
    g = group_diffs(diffs, golden_items(GOLDEN))
    assert g.bad == {"visit:rec:0", "instr:findings"}


def test_top_level_fields_leave_universe_untouched():
    diffs = ["date: expected '2026-05-26', got '2026-05-27'", "title: similarity 0.20 < 0.90"]
    sc = case_scores(GOLDEN, [diffs])
    assert sc["recognition"] == 1.0
    assert len(sc["top_diffs"]) == 2


def test_stability_is_intersection_over_runs():
    run_a = ["biomarker 'Glucose': MISSING in observed output"]
    run_b = []  # everything fine in second run
    sc = case_scores(GOLDEN, [run_a, run_b])
    assert math.isclose(sc["stability"], 6 / 7, rel_tol=1e-9)
    assert sc["unstable_items"] == ["bm:Glucose"]


def test_empty_universe_guard():
    sc = case_scores({"biomarkers": []}, [[]])
    assert sc["recognition"] == 1.0 and sc["stability"] == 1.0


def test_aggregate_multiplies_means():
    agg = aggregate({
        "a": {"recognition": 0.8, "stability": 1.0},
        "b": {"recognition": 1.0, "stability": 0.5},
    })
    assert math.isclose(agg["recognition"], 0.9)
    assert math.isclose(agg["stability"], 0.75)
    assert math.isclose(agg["primary"], 0.675)
