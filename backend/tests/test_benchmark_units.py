"""Offline unit tests for the extraction benchmark helpers (metrics wrapper,
scoring diff-grouping/aggregation, runner merge/fan-out helpers). No network,
no app imports needed for scoring; metrics tests use a fake Mistral-shaped
client."""

import json
import math
import threading
import time
from types import SimpleNamespace

import pytest

from benchmark.metrics import BenchmarkMetrics, InstrumentedMistral
from benchmark.scoring import (
    aggregate,
    case_scores,
    doc_fidelity_for_run,
    golden_items,
    group_diffs,
)

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


# ---------------------------------------------------- pollution counters ---

class _RaisingChat:
    def parse(self, **kwargs):
        raise RuntimeError("provider storm")


def test_provider_error_counted_and_reraised():
    fake = _FakeMistral()
    fake.chat = _RaisingChat()
    m = BenchmarkMetrics()
    wrapped = InstrumentedMistral(fake, m)

    with pytest.raises(RuntimeError):
        wrapped.chat.parse()

    assert m.provider_error_calls == 1
    assert m.llm_calls == 0


def test_watchdog_timeout_counts_provider_error(monkeypatch):
    import benchmark.metrics as bm_mod

    class _StallingChat:
        def parse(self, **kwargs):
            time.sleep(0.3)
            return SimpleNamespace(usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1))

    fake = _FakeMistral()
    fake.chat = _StallingChat()
    m = BenchmarkMetrics()
    wrapped = InstrumentedMistral(fake, m)
    monkeypatch.setattr(bm_mod, "CALL_TIMEOUT_S", 0.05)

    with pytest.raises(TimeoutError):
        wrapped.chat.parse()

    assert m.provider_error_calls == 1
    assert m.llm_calls == 0


def test_counters_merge_and_from_dict_roundtrip():
    a, b = BenchmarkMetrics(), BenchmarkMetrics()
    a.add_fallback_extraction()
    a.add_provider_error()
    b.add_provider_error()
    a.record_stage("extract_s", 1.5)
    b.record_stage("extract_s", 2.5)

    d = a.to_dict()
    assert d["fallback_extractions"] == 1 and d["provider_error_calls"] == 1

    rebuilt = BenchmarkMetrics.from_dict(d)
    rebuilt.merge(b)
    assert rebuilt.fallback_extractions == 1
    assert rebuilt.provider_error_calls == 2
    assert rebuilt.stage_seconds["extract_s"] == 4.0


def test_from_dict_tolerates_missing_keys():
    m = BenchmarkMetrics.from_dict({"llm_calls": 2, "input_tokens": 7})
    assert m.llm_calls == 2 and m.prompt_tokens == 7
    assert m.fallback_extractions == 0 and m.provider_error_calls == 0


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


# --------------------------------------------------- runner merge helpers ---

def test_is_fallback_record_distinguishes_model_unknown():
    from benchmark.run_benchmark import _is_fallback_record

    fallback = SimpleNamespace(entry_type="unknown", notes="Raw OCR text:\n\nstuff")
    model_unknown = SimpleNamespace(entry_type="unknown", notes="Handwriting unreadable")
    blood = SimpleNamespace(entry_type="blood_test", notes="")

    assert _is_fallback_record(fallback)
    assert not _is_fallback_record(model_unknown)
    assert not _is_fallback_record(blood)


def test_run_db_path_is_per_run_and_sibling():
    from benchmark.run_benchmark import _run_db_path

    base = "/x/benchmark_run.db"
    assert _run_db_path(base, 1) == "/x/benchmark_run_r1.db"
    assert _run_db_path(base, 2) == "/x/benchmark_run_r2.db"
    assert _run_db_path(base, 1) != _run_db_path(base, 2)


def test_child_command_propagates_resolved_cases_pristine_and_drift():
    from benchmark.run_benchmark import _child_command

    args = SimpleNamespace(
        pristine="/p/pristine.db", text_threshold=0.9, stage_concurrency=2,
        report="/r/rep.json", allow_corpus_drift=False,
    )
    cmd = _child_command(args, "/x/run_r1.db", "/r/rep.json.child1",
                         "/p/pristine.db", ["a", "b"])
    assert "--child" in cmd
    assert cmd[cmd.index("--pristine") + 1] == "/p/pristine.db"
    assert cmd[cmd.index("--db") + 1] == "/x/run_r1.db"
    assert cmd[cmd.index("--runs") + 1] == "1"
    assert cmd[cmd.index("--stage-concurrency") + 1] == "2"
    # Split/screen-resolved case list must be forwarded explicitly (a child
    # without --cases would otherwise run the WHOLE corpus).
    assert cmd[cmd.index("--cases") + 1] == "a,b"
    assert "--allow-corpus-drift" not in cmd

    args.allow_corpus_drift = True
    cmd2 = _child_command(args, "/x/run_r1.db", "/r/rep.json.child1",
                          "/p/other_pristine.db", ["c"])
    assert cmd2[cmd2.index("--pristine") + 1] == "/p/other_pristine.db"
    assert cmd2[cmd2.index("--cases") + 1] == "c"
    assert "--allow-corpus-drift" in cmd2


def test_merge_child_reports_equals_direct_aggregation_and_sums_wall():
    from benchmark.run_benchmark import _merge_child_reports

    run1 = ["biomarker 'Glucose': MISSING in observed output"]
    run2 = []
    run3 = ["biomarker 'CRP': MISSING in observed output"]
    metrics_r1 = {"llm_calls": 3, "input_tokens": 100, "output_tokens": 50,
                  "fallback_extractions": 1, "provider_error_calls": 0}
    metrics_r2 = {"llm_calls": 2, "input_tokens": 80, "output_tokens": 40,
                  "fallback_extractions": 0, "provider_error_calls": 1}
    reports = [
        {"runs_diffs": {"caseA": [run1], "caseB": [run2]},
         "runs_doc": {"caseA": [0.9], "caseB": [1.0]},
         "metrics": metrics_r1, "wall_s": 100.0, "chat_failovers": 2},
        {"runs_diffs": {"caseA": [run2], "caseB": [run3]},
         "runs_doc": {"caseA": [0.8], "caseB": [0.5]},
         "metrics": metrics_r2, "wall_s": 50.0, "chat_failovers": 1},
    ]

    runs_diffs, runs_doc, tot, wall, failovers = _merge_child_reports(reports)

    # run order preserved, per-case diffs concatenated
    assert runs_diffs["caseA"] == [run1, run2]
    assert runs_diffs["caseB"] == [run2, run3]
    # per-run doc_fidelity scores concatenate in run order too
    assert runs_doc["caseA"] == [0.9, 0.8]
    assert runs_doc["caseB"] == [1.0, 0.5]
    # wall_s keeps its documented sum-of-run-walls semantic
    assert wall == 150.0
    # failover events are summed across children (pollution visibility)
    assert failovers == 3
    assert tot.llm_calls == 5
    assert tot.prompt_tokens == 180
    assert tot.fallback_extractions == 1
    assert tot.provider_error_calls == 1

    # merged diffs score identically to direct N-run aggregation
    merged_a = case_scores(GOLDEN, runs_diffs["caseA"])
    direct_a = case_scores(GOLDEN, [run1, run2])
    assert merged_a["recognition"] == direct_a["recognition"]
    assert merged_a["stability"] == direct_a["stability"]
    assert merged_a["unstable_items"] == direct_a["unstable_items"]
    agg = aggregate({
        "caseA": merged_a,
        "caseB": case_scores(GOLDEN, runs_diffs["caseB"]),
    })
    assert 0.0 <= agg["primary"] <= 1.0


# ------------------------------------------------------ fail-fast fan-out ---

def test_extract_all_sequential_path_preserves_order():
    from benchmark.run_benchmark import _extract_all

    order = []

    def worker(name, input_path):
        order.append(name)
        return name, name

    cases = [(n, n, {}) for n in ["x", "y", "z"]]
    raws = _extract_all(cases, worker, stage_concurrency=1)
    assert order == ["x", "y", "z"]
    assert raws == {"x": "x", "y": "y", "z": "z"}


def test_extract_all_cancels_siblings_on_failure():
    from benchmark.run_benchmark import BenchmarkBroken, _extract_all

    started = []
    lock = threading.Lock()
    # Keeps the second pool worker busy through the cancellation window so
    # c-f stay queued when the failure is handled (cancelling a queued future
    # guarantees it never runs).
    blocker = threading.Event()

    def worker(name, input_path):
        with lock:
            started.append(name)
        if name == "a":
            raise BenchmarkBroken("a: OCR auth")
        blocker.wait(timeout=2.0)
        return name, SimpleNamespace(entry_type="blood_test")

    cases = [(n, f"/tmp/{n}", {}) for n in "abcdef"]
    with pytest.raises(BenchmarkBroken):
        _extract_all(cases, worker, stage_concurrency=2)
    blocker.set()

    # Deterministic bound: 'a' failed, 'b' blocked its worker; only the one
    # freed worker can still dequeue queued work, so at most ONE of c-f ever
    # starts before the rest are cancelled. The point of fail-fast holds: the
    # run never gathers to completion behind a doomed case.
    assert "a" in started
    assert len(started) <= 3


def test_run_parallel_fail_fast_cleans_artifacts(tmp_path, monkeypatch):
    """F12: a failed child's report, run DB and temp log are removed after the
    child is reaped (never while it still holds the files)."""
    import benchmark.run_benchmark as rb

    args = SimpleNamespace(
        runs=2, jobs=2, db=str(tmp_path / "bench.db"),
        report=str(tmp_path / "rep.json"), pristine=str(tmp_path / "pristine.db"),
        text_threshold=0.9, stage_concurrency=1, cases=None,
    )

    class FakePopen:
        def __init__(self, cmd, **kwargs):
            self.returncode = 1
            # simulate children that wrote their reports + run DBs before dying
            for r in (1, 2):
                # exact paths mirror _run_db_path/_run_parallel naming
                (tmp_path / f"bench_r{r}.db").write_bytes(b"db")
                (tmp_path / f"rep.json.child{r}").write_text("{}", encoding="utf-8")

        def poll(self):
            return self.returncode

        def terminate(self):
            pass

        def wait(self):
            return self.returncode

    monkeypatch.setattr(rb.subprocess, "Popen", FakePopen)
    monkeypatch.setattr(rb, "_child_command", lambda *a, **k: ["fake-child"])

    rc = rb._run_parallel(args, [("c", "/tmp/c.pdf", {})], "pristine")

    assert rc == 1
    assert not (tmp_path / "bench_r1.db").exists()
    assert not (tmp_path / "bench_r2.db").exists()
    assert not (tmp_path / "rep.json.child1").exists()
    assert not (tmp_path / "rep.json.child2").exists()


def test_run_parallel_success_cleans_artifacts(tmp_path, monkeypatch):
    """F12: success path also removes per-run DBs/reports/logs."""
    import benchmark.run_benchmark as rb

    args = SimpleNamespace(
        runs=2, jobs=2, db=str(tmp_path / "bench.db"),
        report=None, pristine=str(tmp_path / "pristine.db"),
        text_threshold=0.9, stage_concurrency=1, allow_corpus_drift=False,
        child=False, allow_unclassified=False, screen=False,
    )

    class FakePopen:
        def __init__(self, cmd, **kwargs):
            self.returncode = 0
            r = int(cmd[cmd.index("--db") + 1].rsplit("_r", 1)[1][0])
            (tmp_path / f"bench_r{r}.db").write_bytes(b"db")
            path = cmd[cmd.index("--report") + 1]
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({
                    "runs_diffs": {"caseA": [[]]},
                    "runs_doc": {"caseA": [1.0]},
                    "metrics": {}, "wall_s": 1.0, "chat_failovers": 0,
                }, fh)

        def poll(self):
            return 0

        def terminate(self):
            pass

        def wait(self):
            return 0

    monkeypatch.setattr(rb.subprocess, "Popen", FakePopen)
    monkeypatch.setattr(
        rb, "_child_command",
        lambda args, db, rep, pristine, names: ["fake", "--db", db, "--report", rep,
                                                "--cases", ",".join(names)])

    rc = rb._run_parallel(args, [("caseA", "/tmp/a.pdf", {})],
                          str(tmp_path / "pristine.db"))

    assert rc == 0
    assert not (tmp_path / "bench_r1.db").exists()
    assert not (tmp_path / "bench_r2.db").exists()


def test_run_child_restores_pristine_and_passes_doc_scores(monkeypatch):
    import benchmark.run_benchmark as rb

    calls = {}
    monkeypatch.setattr(rb, "restore_snapshot",
                        lambda pristine, db: calls.__setitem__("restore", (pristine, db)))
    monkeypatch.setattr(rb, "run_once", lambda cases, thr, sc: (
        {"caseA": {"input": "/tmp/a", "runs_diffs": [[]], "runs_doc": [0.75]}},
        "metrics", 1.0,
    ))

    def fake_finalize(args, cases, runs_diffs, m, wall, clock,
                      chat_failovers=None, runs_doc=None):
        calls["runs_doc"] = runs_doc
        return 0

    monkeypatch.setattr(rb, "_finalize", fake_finalize)
    args = SimpleNamespace(pristine="/p", db="/d", text_threshold=0.9, stage_concurrency=1)

    rc = rb._run_child(args, [("caseA", "/tmp/a", {})])

    assert rc == 0
    assert calls["restore"] == ("/p", "/d")
    assert calls["runs_doc"] == {"caseA": [0.75]}


def test_finalize_unclassified_is_broken_unless_allowed():
    from benchmark.metrics import BenchmarkMetrics
    from benchmark.run_benchmark import _finalize

    args = SimpleNamespace(
        runs=1, child=False, report=None, allow_unclassified=False,
        screen=False, jobs=1, stage_concurrency=1, text_threshold=0.9, db="x",
    )
    cases = [("caseA", "/tmp/a.pdf", {"biomarkers": [{"raw_name": "H"}]})]
    runs = {"caseA": [["a diff shape the scoring parser cannot attribute"]]}

    assert _finalize(args, cases, runs, BenchmarkMetrics(), 1.0, 1.0,
                     chat_failovers=0, runs_doc={"caseA": [1.0]}) == 2

    args.allow_unclassified = True
    assert _finalize(args, cases, runs, BenchmarkMetrics(), 1.0, 1.0,
                     chat_failovers=0, runs_doc={"caseA": [1.0]}) == 0


def test_reset_working_db_discards_previous_run_residue(tmp_path):
    from benchmark.run_benchmark import reset_working_db

    seed = tmp_path / "seed.db"
    seed.write_bytes(b"seed")
    live = tmp_path / "live.db"
    live.write_bytes(b"dirty-run-residue")
    (tmp_path / "live.db-wal").write_bytes(b"wal")
    (tmp_path / "live.db-shm").write_bytes(b"shm")

    reset_working_db(str(seed), str(live))

    assert live.read_bytes() == b"seed"
    assert not (tmp_path / "live.db-wal").exists()
    assert not (tmp_path / "live.db-shm").exists()


def test_effective_chat_provider_mirrors_env_gating(monkeypatch):
    from benchmark.run_benchmark import _effective_chat_provider

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("CHAT_PROVIDER", raising=False)
    monkeypatch.delenv("CHAT_FAILOVER", raising=False)
    assert _effective_chat_provider() == "mistral"

    monkeypatch.setenv("CHAT_PROVIDER", "openrouter")
    assert _effective_chat_provider() == "mistral"  # no key -> still Mistral

    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    assert _effective_chat_provider() == "openrouter"

    monkeypatch.delenv("CHAT_PROVIDER")
    monkeypatch.setenv("CHAT_FAILOVER", "openrouter")
    assert _effective_chat_provider() == "mistral+openrouter-failover"


# --------------------------------------------------- metric v2: F7 ---

DOC_GOLDEN = {
    "entry_type": "blood_test",
    "date": "2026-05-26",
    "time": "08:30",
    "clinic": "Invivo",
    "provider": "",
    "title": "CBC",
    "notes": "",
    "biomarkers": [],
}


def _observed(**over):
    obs = {
        "entry_type": "blood_test",
        "date": "2026-05-26",
        "time": "08:30",
        "clinic": "Invivo",
        "provider": "",
        "title": "CBC",
        "notes": "",
    }
    obs.update(over)
    return obs


def test_doc_fidelity_perfect_and_time_drop_counts_as_miss():
    score, fields = doc_fidelity_for_run(DOC_GOLDEN, _observed())
    assert score == 1.0
    assert fields["time"] is True

    score2, fields2 = doc_fidelity_for_run(DOC_GOLDEN, _observed(time=""))
    assert fields2["time"] is False
    # golden-empty fields (provider/notes) are not scored at all
    assert set(fields2) == {"entry_type", "date", "time", "clinic", "title"}
    assert math.isclose(score2, 4 / 5)


def test_doc_fidelity_accepts_alt_renderings_and_similarity():
    golden = dict(DOC_GOLDEN, clinic_alt=["Invitro"])
    score, fields = doc_fidelity_for_run(golden, _observed(clinic="Invitro"))
    assert score == 1.0 and fields["clinic"] is True


def test_doc_fidelity_all_empty_golden_is_one():
    score, fields = doc_fidelity_for_run({}, {})
    assert score == 1.0 and fields == {}


def test_extras_stable_counts_names_present_in_every_run():
    every_run = "biomarker 'Mystery': UNEXPECTED in observed output (not in golden)"
    once = "biomarker 'One-off': UNEXPECTED in observed output (not in golden)"
    sc = case_scores(GOLDEN, [[every_run, once], [every_run]])
    assert sc["extras_total"] == 3
    assert sc["extras_stable"] == 1
    assert sc["stable_extra_items"] == ["Mystery"]
