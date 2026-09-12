"""Unit tests for the F6/F8/F9/F10/F15 harness surfaces: report comparison
verdicts, keep statistics, screen-mode argument resolution, corpus manifest
hashing/drift, and snapshot-input fingerprints. No network, no app imports,
no DB."""

import json

import pytest

from benchmark.compare_reports import (
    EPSILON,
    MIN_EPSILON,
    _effective_epsilon,
    _recognition_ci,
    compare_reports,
)
from benchmark.report_schema import METRIC_VERSION, VERDICT_EXIT_CODES
from benchmark.run_benchmark import parse_args


def _report(primary=0.9, mode="full", runs=3, metric_version=METRIC_VERSION, **cfg_over):
    config = {
        "metric_version": metric_version,
        "mode": mode,
        "runs": runs,
        "cases": ["a", "b"],
        "git_head": "abc123",
        "git_dirty": False,
        "chat_provider": "mistral",
        "chat_model": "mistral-medium-latest",
        "openrouter_model": None,
        "openrouter_scope": None,
        "chat_failover": None,
        "ocr_model": "mistral-ocr-latest",
        "ocr_markdown_clean": "1",
        "text_threshold": 0.9,
        "corpus_hash": "corpus",
        "golden_hash": "golden",
        "snapshot_fingerprint": "snap",
        "snapshot_code_fingerprint": "snap-code",
        "snapshot_data_fingerprint": "snap-data",
    }
    config.update(cfg_over)
    return {
        "config": config,
        "aggregate": {"recognition": primary, "stability": 1.0,
                      "primary": primary, "doc_fidelity": 1.0, "extras_stable": 0},
        "metrics": {"input_tokens": 100, "output_tokens": 50,
                    "fallback_extractions": 0, "provider_error_calls": 0},
        "unclassified_total": 0,
        "chat_failovers": 0,
        "wall_s": 10.0,
        "cases": {"a": {"recognition": primary, "stability": 1.0, "doc_fidelity": 1.0}},
    }


def _report_with_cases(primary, cases, **over):
    report = _report(primary, **over)
    report["cases"] = cases
    return report


# ------------------------------------------------------- verdicts (F9) ---

def test_keep_when_delta_meets_epsilon():
    result = compare_reports(_report(0.90), _report(0.93))
    assert result["verdict"] == "KEEP"
    assert result["delta_primary"] == pytest.approx(0.03)


def test_within_epsilon_is_discard():
    result = compare_reports(_report(0.90), _report(0.91))
    assert result["verdict"] == "DISCARD"
    assert not result["promising"]


def test_pollution_beats_all_decisions():
    new = _report(0.99)
    new["metrics"]["fallback_extractions"] = 1
    result = compare_reports(_report(0.90), new)
    assert result["verdict"] == "POLLUTED"


def test_fingerprint_mismatch_is_broken_unless_allowed():
    new = _report(0.99, snapshot_data_fingerprint="different")
    result = compare_reports(_report(0.90), new)
    assert result["verdict"] == "BROKEN"
    assert result["fingerprint_mismatches"][0]["field"] == "snapshot_data_fingerprint"

    allowed = compare_reports(_report(0.90), new, allow_env_drift=True)
    assert allowed["verdict"] == "KEEP"


def test_code_drift_is_recorded_not_vetoed():
    new = _report(0.93, git_head="different", git_dirty=True,
                  snapshot_code_fingerprint="different",
                  snapshot_fingerprint="different")
    result = compare_reports(_report(0.90), new)
    assert result["verdict"] == "KEEP"
    assert {d["field"] for d in result["code_drift"]} == {
        "git_head", "git_dirty", "snapshot_code_fingerprint",
        "snapshot_fingerprint"}
    assert any("code drift recorded" in r for r in result["reasons"])


def test_foreign_metric_version_is_broken():
    result = compare_reports(_report(0.90), _report(0.99, metric_version=1))
    assert result["verdict"] == "BROKEN"


def test_unclassified_is_broken_unless_allowed():
    new = _report(0.99)
    new["unclassified_total"] = 2
    assert compare_reports(_report(0.90), new)["verdict"] == "BROKEN"
    assert compare_reports(_report(0.90), new, allow_unclassified=True)["verdict"] == "KEEP"


def test_screen_report_can_never_keep():
    result = compare_reports(_report(0.90, runs=3),
                             _report(0.99, mode="screen", runs=1))
    assert result["verdict"] == "DISCARD"
    assert result["promising"] is True
    assert "full verify" in " ".join(result["reasons"])


def test_baseline_allow_unclassified_does_not_license_candidates():
    baseline = _report(0.90, allow_unclassified=True)
    new = _report(0.99)
    new["unclassified_total"] = 1
    assert compare_reports(baseline, new)["verdict"] == "BROKEN"


def test_cost_keep_on_exact_tie_with_token_win():
    new = _report(0.90)
    new["metrics"]["input_tokens"] = 50  # 50% win, clears the 25% threshold
    result = compare_reports(_report(0.90), new)
    assert result["verdict"] == "KEEP"
    assert result["keep_basis"] == "cost"
    assert result["cost_wins"] == {"input_tokens": 0.5}
    assert any("cost keep" in r for r in result["reasons"])


def test_small_cost_win_on_tie_stays_informational():
    new = _report(0.90)
    new["metrics"]["input_tokens"] = 90  # 10% win, below the threshold
    result = compare_reports(_report(0.90), new)
    assert result["verdict"] == "DISCARD"
    assert result["cost_wins"] == {}
    assert result["cost_tie_break"] == "new"
    assert any("tie-break" in r for r in result["reasons"])


def test_cost_regression_flagged_but_keep_stands():
    new = _report(0.95)
    new["metrics"]["input_tokens"] = 300
    new["wall_s"] = 30.0
    result = compare_reports(_report(0.90), new)
    assert result["verdict"] == "KEEP"
    assert result["keep_basis"] == "quality"
    assert set(result["cost_regression"]) == {"input_tokens", "wall_s"}


# ------------------------------------------------- F15 keep statistics ---

def test_json_safe_replaces_nonfinite_floats():
    from benchmark.compare_reports import _json_safe

    dumped = json.loads(json.dumps(_json_safe({"ratio": float("inf"),
                                               "nested": [float("-inf")]})))
    assert dumped == {"ratio": "inf", "nested": ["-inf"]}


def test_effective_epsilon_scales_floors_and_respects_explicit():
    assert _effective_epsilon(0.9, None) == EPSILON
    assert _effective_epsilon(0.99, None) == pytest.approx(0.0025)
    assert _effective_epsilon(1.0, None) == MIN_EPSILON
    assert _effective_epsilon(0.9, 0.05) == 0.05  # explicit = absolute cap


def test_recognition_ci_none_without_vectors_and_deterministic():
    assert _recognition_ci({"cases": {}}, {"cases": {}}) is None
    base_cases = {"a": {"recognition": 0.9, "stability": 1.0, "universe_size": 10,
                        "per_run_recognition": [0.8, 0.9, 1.0]}}
    new_cases = {"a": {"recognition": 0.95, "stability": 1.0, "universe_size": 10,
                       "per_run_recognition": [0.9, 1.0, 0.95]}}
    first = _recognition_ci(_report_with_cases(0.9, base_cases),
                            _report_with_cases(0.95, new_cases))
    second = _recognition_ci(_report_with_cases(0.9, base_cases),
                             _report_with_cases(0.95, new_cases))
    assert first == second
    assert first["low"] < first["high"]


def test_relative_epsilon_plus_ci_keeps_small_gain():
    base_cases = {"a": {"recognition": 0.99, "stability": 1.0, "universe_size": 100,
                        "per_run_recognition": [0.99, 0.99, 0.99]}}
    new_cases = {"a": {"recognition": 0.9935, "stability": 1.0, "universe_size": 100,
                       "per_run_recognition": [0.9935, 0.9935, 0.9935]}}
    result = compare_reports(_report_with_cases(0.99, base_cases),
                             _report_with_cases(0.9935, new_cases))
    assert result["epsilon_effective"] == pytest.approx(0.0025)
    assert result["verdict"] == "KEEP"
    assert result["keep_basis"] == "noise-aware"


def test_small_gain_with_ci_spanning_zero_discards():
    base_cases = {"a": {"recognition": 0.99, "stability": 1.0, "universe_size": 100,
                        "per_run_recognition": [0.98, 0.99, 1.0]}}
    new_cases = {"a": {"recognition": 0.9933, "stability": 1.0, "universe_size": 100,
                       "per_run_recognition": [0.99, 0.99, 1.0]}}
    result = compare_reports(_report_with_cases(0.99, base_cases),
                             _report_with_cases(0.9933, new_cases))
    assert result["recognition_ci"]["low"] <= 0
    assert result["verdict"] == "DISCARD"
    assert any("noise territory" in r for r in result["reasons"])


def test_strong_gain_keeps_despite_noisy_recognition_ci():
    base_cases = {"a": {"recognition": 0.90, "stability": 1.0, "universe_size": 100,
                        "per_run_recognition": [0.8, 0.9, 1.0]}}
    new_cases = {"a": {"recognition": 0.93, "stability": 1.0, "universe_size": 100,
                       "per_run_recognition": [0.9, 1.0, 0.89]}}
    result = compare_reports(_report_with_cases(0.90, base_cases),
                             _report_with_cases(0.93, new_cases))
    assert result["recognition_ci"]["low"] <= 0
    assert result["verdict"] == "KEEP"
    assert result["keep_basis"] == "quality"


def test_case_gate_vetoes_quality_keep():
    base_cases = {
        "a": {"recognition": 0.80, "stability": 1.0, "universe_size": 10},
        "b": {"recognition": 0.90, "stability": 1.0, "universe_size": 10},
    }
    new_cases = {
        "a": {"recognition": 1.00, "stability": 1.0, "universe_size": 10},
        "b": {"recognition": 0.60, "stability": 1.0, "universe_size": 10},
    }
    result = compare_reports(_report_with_cases(0.80, base_cases),
                             _report_with_cases(0.85, new_cases))
    assert result["verdict"] == "DISCARD"
    assert result["promising"] is True
    assert {v["case"] for v in result["case_gate"]} == {"b"}
    assert any("non-regression gate" in r for r in result["reasons"])


def test_case_flake_below_threshold_does_not_veto_keep():
    base_cases = {
        "a": {"recognition": 0.90, "stability": 1.0, "universe_size": 100},
        "b": {"recognition": 0.90, "stability": 1.0, "universe_size": 100},
    }
    new_cases = {
        "a": {"recognition": 0.95, "stability": 1.0, "universe_size": 100},
        "b": {"recognition": 0.895, "stability": 1.0, "universe_size": 100},
    }
    result = compare_reports(_report_with_cases(0.90, base_cases),
                             _report_with_cases(0.93, new_cases))
    assert result["case_gate"] == []
    assert result["verdict"] == "KEEP"


def test_case_gate_vetoes_majority_run_drop():
    base_cases = {
        "a": {"recognition": 0.90, "stability": 1.0,
              "per_run_recognition": [0.9, 0.9, 0.9]},
        "b": {"recognition": 0.90, "stability": 1.0,
              "per_run_recognition": [0.9, 0.9, 0.9]},
    }
    new_cases = {
        "a": {"recognition": 0.95, "stability": 1.0,
              "per_run_recognition": [0.95, 0.95, 0.95]},
        "b": {"recognition": 0.8334, "stability": 1.0,
              "per_run_recognition": [0.7, 0.7, 0.9]},
    }
    result = compare_reports(_report_with_cases(0.90, base_cases),
                             _report_with_cases(0.93, new_cases))
    assert result["verdict"] == "DISCARD"
    gate = result["case_gate"]
    assert len(gate) == 1 and gate[0]["case"] == "b"
    assert gate[0]["runs_worse"] == 2 and gate[0]["runs"] == 3


def test_case_gate_ignores_single_run_flake():
    # the documented visit-replay flake shape: one contaminated run in a
    # small case (гастроэнтеролог_ргц) must not veto a proven keep
    base_cases = {"a": {"recognition": 0.6, "stability": 0.6,
                        "per_run_recognition": [0.6, 0.6, 0.6]}}
    new_cases = {"a": {"recognition": 0.5333, "stability": 0.4,
                       "per_run_recognition": [0.4, 0.6, 0.6]}}
    result = compare_reports(_report_with_cases(0.85, base_cases),
                             _report_with_cases(0.93, new_cases))
    assert result["case_gate"] == []
    assert result["verdict"] == "KEEP"


def test_case_gate_ignores_consistent_sub_threshold_drop():
    # 1 item of 31 lost in every run (оак_26.05 shape) is below materiality
    base_cases = {"a": {"recognition": 0.9677, "stability": 0.9677,
                        "per_run_recognition": [0.9677, 0.9677, 0.9677]}}
    new_cases = {"a": {"recognition": 0.9355, "stability": 0.9355,
                       "per_run_recognition": [0.9355, 0.9355, 0.9355]}}
    result = compare_reports(_report_with_cases(0.85, base_cases),
                             _report_with_cases(0.90, new_cases))
    assert result["case_gate"] == []
    assert result["verdict"] == "KEEP"


def test_cost_keep_vetoed_by_case_gate():
    base_cases = {
        "a": {"recognition": 0.90, "stability": 1.0, "universe_size": 10},
        "b": {"recognition": 0.90, "stability": 1.0, "universe_size": 10},
    }
    new_cases = {
        "a": {"recognition": 0.90, "stability": 1.0, "universe_size": 10},
        "b": {"recognition": 0.80, "stability": 1.0, "universe_size": 10},
    }
    new = _report_with_cases(0.895, new_cases)
    new["metrics"]["input_tokens"] = 50
    result = compare_reports(_report_with_cases(0.90, base_cases), new)
    assert result["cost_wins"]
    assert result["verdict"] == "DISCARD"
    assert any("non-regression gate" in r for r in result["reasons"])


def test_cost_win_vetoed_by_cost_regression():
    new = _report(0.90)
    new["metrics"]["input_tokens"] = 50
    new["metrics"]["output_tokens"] = 300
    result = compare_reports(_report(0.90), new)
    assert result["verdict"] == "DISCARD"
    assert "output_tokens" in result["cost_regression"]
    assert any("cost win vetoed" in r for r in result["reasons"])


def test_cost_win_vetoed_when_quality_drops_beyond_epsilon():
    new = _report(0.85)
    new["metrics"]["input_tokens"] = 50
    result = compare_reports(_report(0.90), new)
    assert result["verdict"] == "DISCARD"
    assert any("non-inferiority" in r for r in result["reasons"])


def test_screen_with_cost_win_can_never_keep_but_is_promising():
    new = _report(0.90, mode="screen", runs=1)
    new["metrics"]["input_tokens"] = 50
    result = compare_reports(_report(0.90), new)
    assert result["verdict"] == "DISCARD"
    assert result["promising"] is True
    assert "screen" in " ".join(result["reasons"])


def test_verdict_exit_codes_cover_all_verdicts():
    assert VERDICT_EXIT_CODES == {"KEEP": 0, "DISCARD": 1, "BROKEN": 2, "POLLUTED": 3}


# ------------------------------------------------ screen args (F9/F7) ---

def test_screen_forces_runs_one_and_requires_cases():
    args = parse_args(["--screen", "--cases", "a,b"])
    assert args.screen and args.runs == 1
    with pytest.raises(SystemExit):
        parse_args(["--screen"])
    with pytest.raises(SystemExit):
        parse_args(["--screen", "--runs", "3", "--cases", "a"])


def test_default_runs_is_three_and_explicit_runs_respected():
    assert parse_args([]).runs == 3
    assert parse_args(["--runs", "2"]).runs == 2


# ------------------------------------------- corpus manifest (F6) ---

def _write_case(corpus, name, golden):
    cdir = corpus / name
    cdir.mkdir(parents=True)
    (cdir / "doc.pdf").write_bytes(b"document-bytes")
    (cdir / "standardized.json").write_text(json.dumps(golden), encoding="utf-8")


def test_manifest_hash_drift_and_provenance(tmp_path, monkeypatch):
    import benchmark.run_benchmark as rb

    corpus = tmp_path / "corpus"
    _write_case(corpus, "case1", {"biomarkers": []})
    monkeypatch.setattr(rb, "CORPUS_DIR", str(corpus))
    monkeypatch.setattr(rb, "CORPUS_MANIFEST", str(corpus / "manifest.json"))
    monkeypatch.setattr(rb, "_sha256_cache", {})

    assert rb.write_corpus_manifest() == 0
    manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["cases"]["case1"]["split"] == "unassigned"
    assert manifest["cases"]["case1"]["document_sha256"]

    # provenance + curator metadata survive a re-hash, including keys the
    # writer does not know about (F6 expected metric range)
    manifest["cases"]["case1"]["split"] = "tuning"
    manifest["cases"]["case1"]["reviewer"] = "dr-meetch"
    manifest["cases"]["case1"]["expected_primary"] = [0.9, 1.0]
    (corpus / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    rb._sha256_cache.clear()
    rb.write_corpus_manifest()
    manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["cases"]["case1"]["split"] == "tuning"
    assert manifest["cases"]["case1"]["reviewer"] == "dr-meetch"
    assert manifest["cases"]["case1"]["expected_primary"] == [0.9, 1.0]

    assert [c[0] for c in rb.load_corpus()] == ["case1"]
    # split filter with no matching cases is a hard error, not an empty run
    with pytest.raises(SystemExit):
        rb.load_corpus(split="validation")

    # tampering with the verified golden hard-fails once hashes are cached;
    # clear the cache to simulate a fresh process reading the changed file
    golden_path = corpus / "case1" / "standardized.json"
    golden_path.write_text(json.dumps({"biomarkers": [{"raw_name": "X"}]}), encoding="utf-8")
    rb._sha256_cache.clear()
    with pytest.raises(SystemExit):
        rb.load_corpus()
    assert [c[0] for c in rb.load_corpus(allow_drift=True)] == ["case1"]


def test_manifest_refuses_to_wipe_nonempty_manifest(tmp_path, monkeypatch):
    import benchmark.run_benchmark as rb

    corpus = tmp_path / "corpus"
    corpus.mkdir()
    manifest = {"schema": 1, "cases": {
        "gone": {"split": "tuning", "expected_primary": [0.9, 1.0]}}}
    (corpus / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(rb, "CORPUS_DIR", str(corpus))
    monkeypatch.setattr(rb, "CORPUS_MANIFEST", str(corpus / "manifest.json"))

    assert rb.write_corpus_manifest() == 2
    data = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
    assert data["cases"]["gone"]["expected_primary"] == [0.9, 1.0]


def test_malformed_corpus_case_is_a_hard_error(tmp_path, monkeypatch):
    import benchmark.run_benchmark as rb

    corpus = tmp_path / "corpus"
    case = corpus / "broken"
    case.mkdir(parents=True)
    (case / "standardized.json").write_text("{}", encoding="utf-8")  # no document
    monkeypatch.setattr(rb, "CORPUS_DIR", str(corpus))
    monkeypatch.setattr(rb, "CORPUS_MANIFEST", str(corpus / "manifest.json"))

    with pytest.raises(SystemExit):
        rb.load_corpus()


def test_snapshot_fingerprint_tracks_content_and_splits_code_data(tmp_path, monkeypatch):
    import benchmark.run_benchmark as rb

    code = tmp_path / "matcher.py"
    data = tmp_path / "Loinc.csv"
    code.write_text("x = 1", encoding="utf-8")
    data.write_text("d = 1", encoding="utf-8")
    monkeypatch.setattr(rb, "SNAPSHOT_CODE_INPUTS", [str(code)])
    monkeypatch.setattr(rb, "SNAPSHOT_CODE_GLOBS", [])
    monkeypatch.setattr(rb, "SNAPSHOT_DATA_INPUTS", [str(data)])
    monkeypatch.setattr(rb, "SNAPSHOT_DATA_GLOBS", [])
    monkeypatch.setattr(rb, "_sha256_cache", {})

    first = rb.snapshot_inputs_fingerprint()
    assert first["code_fingerprint"] != first["data_fingerprint"]
    assert first["fingerprint"] != first["code_fingerprint"]

    code.write_text("x = 2", encoding="utf-8")
    rb._sha256_cache.clear()
    second = rb.snapshot_inputs_fingerprint()
    assert second["fingerprint"] != first["fingerprint"]
    assert second["code_fingerprint"] != first["code_fingerprint"]
    assert second["data_fingerprint"] == first["data_fingerprint"]

    data.write_text("d = 2", encoding="utf-8")
    rb._sha256_cache.clear()
    third = rb.snapshot_inputs_fingerprint()
    assert third["data_fingerprint"] != second["data_fingerprint"]
    assert any(key.endswith("matcher.py") for key in third["components"])
