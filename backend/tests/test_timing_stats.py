"""Tests for the rolling extraction-timing stats behind the SSE `estimate_s`
progress values. Each test runs against its own in-memory engine — the
service is monkeypatched away from the shared file-backed SessionLocal so
test samples never pollute (or read) the dev DB."""

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

    def test_record_rejects_implausibly_fast_samples(self, stats_db):
        # Mocked /api/extract test runs complete a "stage" in ~1e-4s; such
        # rows would poison the rolling window and collapse the estimate.
        timing_stats.record("extract", 0.0001, chars=17)
        timing_stats.record("ocr", 0.0002)
        timing_stats.record("match", 0.0001)
        assert _rows(stats_db, "extract") == []
        assert _rows(stats_db, "ocr") == []
        assert _rows(stats_db, "match") == []

    def test_record_rejects_zero_char_extract_samples(self, stats_db):
        timing_stats.record("extract", 10.0, chars=0)
        assert _rows(stats_db, "extract") == []

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
            2.0 + 0.0023 * 4000
        )
        assert timing_stats.estimate("match") == pytest.approx(3.5)
        assert timing_stats.estimate("ocr") == pytest.approx(1.5)

    def test_flat_median_for_match(self, stats_db):
        for s in (1.0, 2.0, 3.0, 4.0, 100.0):
            timing_stats.record("match", s)
        # Median (3.0), not mean — one outlier must not inflate the estimate.
        assert timing_stats.estimate("match") == pytest.approx(3.0)

    def test_extract_theil_sen_fit_with_intercept(self, stats_db):
        # Samples on the exact line seconds = 2 + 0.002 * chars.
        for chars, sec in ((3000, 8), (3500, 9), (4000, 10), (4500, 11), (5000, 12)):
            timing_stats.record("extract", sec, chars=chars)
        assert timing_stats.estimate("extract", 4000) == pytest.approx(10.0)
        assert timing_stats.estimate("extract", 6000) == pytest.approx(14.0)

    def test_extract_fit_is_robust_to_a_few_outliers(self, stats_db):
        # One night-run outlier (40s) among five on-line samples must not
        # drag the fit: Theil–Sen tolerates <29% outliers.
        for chars, sec in ((3000, 8), (3500, 9), (4000, 10), (4500, 11), (5000, 12)):
            timing_stats.record("extract", sec, chars=chars)
        timing_stats.record("extract", 40.0, chars=1000)
        assert timing_stats.estimate("extract", 6000) == pytest.approx(14.0)

    def test_extract_estimate_has_floor(self, stats_db):
        # A near-flat pool (tiny intercept) still never estimates below 2s.
        for chars, sec in ((1000, 0.4), (2000, 0.5), (3000, 0.6), (4000, 0.7), (5000, 0.8)):
            timing_stats.record("extract", sec, chars=chars)
        assert timing_stats.estimate("extract", 5000) == pytest.approx(2.0)

    def test_extract_degenerate_pool_falls_back_to_constants(self, stats_db):
        # All samples share one char count → no pairwise slopes → the fit is
        # undefined, so the fitted cold-start constants are used instead.
        for sec in (8.0, 9.0, 10.0, 11.0, 12.0):
            timing_stats.record("extract", sec, chars=4000)
        assert timing_stats.estimate("extract", 4000) == pytest.approx(
            2.0 + 0.0023 * 4000
        )

    def test_extract_ignores_legacy_implausible_rows_on_read(self, stats_db):
        # Rows stored by older builds before the write-side guard existed
        # (mocked test runs: ~1e-4s, a handful of chars) must not skew the
        # fit — the read-side filter makes them inert without a migration.
        db = stats_db()
        try:
            for i in range(15):
                db.add(ExtractionTimingSample(stage="extract", seconds=0.0001, chars=8 + i))
            db.commit()
        finally:
            db.close()
        for chars, sec in ((3000, 8), (3500, 9), (4000, 10), (4500, 11), (5000, 12)):
            timing_stats.record("extract", sec, chars=chars)
        assert timing_stats.estimate("extract", 4000) == pytest.approx(10.0)

    def test_match_ignores_legacy_implausible_rows_on_read(self, stats_db):
        db = stats_db()
        try:
            for _ in range(10):
                db.add(ExtractionTimingSample(stage="match", seconds=0.0001, chars=0))
            db.commit()
        finally:
            db.close()
        for s in (2.0, 3.0, 4.0, 5.0, 6.0):
            timing_stats.record("match", s)
        assert timing_stats.estimate("match") == pytest.approx(4.0)

    def test_unknown_stage_returns_match_fallback(self, stats_db):
        assert timing_stats.estimate("nope") == pytest.approx(3.5)
