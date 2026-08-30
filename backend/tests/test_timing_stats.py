"""Tests for the rolling extraction-timing stats behind the SSE `estimate_s`
progress values. Each test runs against its own in-memory engine — the
service is monkeypatched away from the shared file-backed SessionLocal so
test samples never pollute (or read) the dev DB."""

import statistics

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.services.timing_stats as timing_stats
from app.db.models import ExtractionTimingSample
from app.db.session import Base


@pytest.fixture
def stats_db(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(timing_stats, "SessionLocal", TestingSessionLocal)
    return TestingSessionLocal


def _rows(stats_db, stage):
    db = stats_db()
    try:
        return (
            db.query(ExtractionTimingSample)
            .filter(ExtractionTimingSample.stage == stage)
            .order_by(ExtractionTimingSample.id)
            .all()
        )
    finally:
        db.close()


class TestRecord:
    def test_record_persists_samples(self, stats_db):
        timing_stats.record("extract", 10.0, chars=4000)
        timing_stats.record("ocr", 1.2)
        rows = _rows(stats_db, "extract")
        assert len(rows) == 1
        assert rows[0].seconds == pytest.approx(10.0)
        assert rows[0].chars == 4000
        assert _rows(stats_db, "ocr")[0].chars == 0

    def test_record_ignores_invalid_input(self, stats_db):
        timing_stats.record("extract", float("nan"))
        timing_stats.record("extract", -3.0)
        timing_stats.record("bogus-stage", 5.0)
        assert _rows(stats_db, "extract") == []
        assert _rows(stats_db, "bogus-stage") == []

    def test_record_prunes_to_max_samples(self, stats_db, monkeypatch):
        monkeypatch.setattr(timing_stats, "MAX_SAMPLES", 5)
        for i in range(8):
            timing_stats.record("match", 1.0 + i)
        rows = _rows(stats_db, "match")
        assert len(rows) == 5
        # Only the most recent samples survive the prune.
        assert [r.seconds for r in rows] == [4.0, 5.0, 6.0, 7.0, 8.0]


class TestEstimate:
    def test_cold_start_uses_fitted_constants(self, stats_db):
        assert timing_stats.estimate("extract", 4000) == pytest.approx(
            2.0 + 0.003 * 4000
        )
        assert timing_stats.estimate("match") == pytest.approx(3.5)
        assert timing_stats.estimate("ocr") == pytest.approx(1.5)

    def test_flat_median_for_match(self, stats_db):
        for s in (1.0, 2.0, 3.0, 4.0, 100.0):
            timing_stats.record("match", s)
        # Median (3.0), not mean — one outlier must not inflate the estimate.
        assert timing_stats.estimate("match") == pytest.approx(3.0)

    def test_extract_scales_with_chars_via_ratio_median(self, stats_db):
        for sec, chars in ((10.0, 4000), (5.0, 2000), (2.5, 1000), (12.0, 4000), (7.5, 3000)):
            timing_stats.record("extract", sec, chars=chars)
        ratios = [10 / 4000, 5 / 2000, 2.5 / 1000, 12 / 4000, 7.5 / 3000]
        expected = max(2.0, statistics.median(ratios) * 6000)
        assert timing_stats.estimate("extract", 6000) == pytest.approx(expected)

    def test_extract_estimate_has_floor(self, stats_db):
        for s in (0.5, 0.6, 0.7, 0.8, 0.9):
            timing_stats.record("extract", s, chars=4000)
        assert timing_stats.estimate("extract", 1000) == pytest.approx(2.0)

    def test_extract_ignores_zero_char_rows(self, stats_db):
        timing_stats.record("extract", 10.0, chars=0)
        for s in (8.0, 9.0, 10.0, 11.0, 12.0):
            timing_stats.record("extract", s, chars=4000)
        assert timing_stats.estimate("extract", 4000) == pytest.approx(10.0)

    def test_unknown_stage_returns_match_fallback(self, stats_db):
        assert timing_stats.estimate("nope") == pytest.approx(3.5)
