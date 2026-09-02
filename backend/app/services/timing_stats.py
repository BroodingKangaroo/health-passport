"""Rolling per-stage extraction timing stats.

Every `/api/extract` run already measures its OCR / LLM-extraction / matching
durations for logging; these samples are persisted here (pruned to the last N
per stage) so the SSE `progress` events can carry an `estimate_s` that tracks
*current* provider latency. LLM latency drifts heavily over time (the same
blood test went from ~22s to ~10s of extraction within weeks), so estimates
come from recent samples rather than baked-in constants.

Cold start (fewer than MIN_SAMPLES plausible samples for a stage) falls back
to static constants fitted from historical app.log data until real samples
accumulate.
"""

import logging
import math
import statistics
from typing import Optional

from sqlalchemy import delete, select

from app.db.models import ExtractionTimingSample
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

STAGE_OCR = "ocr"
STAGE_EXTRACT = "extract"
STAGE_MATCH = "match"
_STAGES = (STAGE_OCR, STAGE_EXTRACT, STAGE_MATCH)

# Samples kept per stage: large enough for a stable fit, small enough
# that the estimate re-adapts within a handful of runs after latency drifts.
MAX_SAMPLES = 20
# Below this many samples the fit is too noisy — use the fallback constants.
MIN_SAMPLES = 5

# Plausibility floor (seconds): every real stage involves a network
# round-trip, so anything faster cannot be a genuine provider latency — it is
# a mocked run (e.g. the /api/extract tests, whose stages complete in ~1e-4s).
# Such samples would poison the rolling window and collapse the estimate to
# its floor, so they are rejected on write AND ignored on read (the read-side
# filter also neutralizes implausible rows already stored by older builds,
# without needing a data migration).
_MIN_PLAUSIBLE_S = 0.25

# Never advertise less than this many seconds for a stage.
_MIN_ESTIMATE_S = 2.0

# Cold-start constants (seconds), fitted from recent app.log history:
# extraction ≈ 2s fixed + ~0.0023 s/char (a 31-biomarker panel ≈ 3700 chars
# ≈ 10.5s); OCR ≈ 0.8–3.5s flat; matching ≈ 0.6–7.5s flat (weak
# biomarker-count dependence).
_FALLBACK_OCR_S = 1.5
_FALLBACK_EXTRACT_INTERCEPT_S = 2.0
_FALLBACK_EXTRACT_SEC_PER_CHAR = 0.0023
_FALLBACK_MATCH_S = 3.5


def record(stage: str, seconds: float, chars: int = 0) -> None:
    """Persist one completed stage duration and prune old samples.

    Best-effort: called from the SSE generator after each stage, so any
    failure here must never break the extraction stream. Implausibly fast
    samples (mocked runs) and zero-char extract samples are rejected.
    """
    if stage not in _STAGES or not math.isfinite(seconds) or seconds < _MIN_PLAUSIBLE_S:
        return
    if stage == STAGE_EXTRACT and chars <= 0:
        return
    try:
        db = SessionLocal()
        try:
            db.add(ExtractionTimingSample(stage=stage, seconds=seconds, chars=chars))
            db.commit()
            _prune(db, stage)
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
    except Exception:
        logger.warning("timing_stats.record failed for stage %s", stage, exc_info=True)


def _prune(db, stage: str) -> None:
    # Keep only the MAX_SAMPLES most recent rows for this stage.
    keep_ids = select(ExtractionTimingSample.id).where(
        ExtractionTimingSample.stage == stage
    ).order_by(ExtractionTimingSample.id.desc()).limit(MAX_SAMPLES).scalar_subquery()
    db.execute(
        delete(ExtractionTimingSample).where(
            ExtractionTimingSample.stage == stage,
            ExtractionTimingSample.id.not_in(keep_ids),
        )
    )
    db.commit()


def _recent(stage: str) -> list[ExtractionTimingSample]:
    db = SessionLocal()
    try:
        return list(
            db.query(ExtractionTimingSample)
            .filter(ExtractionTimingSample.stage == stage)
            .order_by(ExtractionTimingSample.id.desc())
            .limit(MAX_SAMPLES)
            .all()
        )
    finally:
        db.close()


def _theil_sen(points: list) -> Optional[tuple[float, float]]:
    """Robust linear fit of (chars, seconds) → (intercept, slope).

    Theil–Sen: the slope is the median of pairwise slopes, the intercept the
    median of residuals against that slope. Breaks down only when >29% of
    points are outliers; returns None for degenerate pools (all-equal chars,
    fewer than two distinct abscissae).
    """
    slopes = []
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            (x1, y1), (x2, y2) = points[i], points[j]
            if x2 != x1:
                slopes.append((y2 - y1) / (x2 - x1))
    if not slopes:
        return None
    slope = statistics.median(slopes)
    intercept = statistics.median(y - slope * x for x, y in points)
    return intercept, slope


def estimate(stage: str, chars: int = 0) -> float:
    """Estimated seconds for `stage` (with `chars` of markdown for extract).

    The extract estimate is a Theil–Sen intercept+slope fit over the recent
    (chars, seconds) samples — modeling the fixed LLM cost keeps small
    documents from inflating the slope and lets the estimate scale with
    document size; ocr/match are flat medians. Implausibly fast samples
    (mocked runs) are ignored on read. Falls back to the fitted constants
    until MIN_SAMPLES plausible samples exist.
    """
    if stage == STAGE_EXTRACT:
        try:
            samples = [
                s for s in _recent(stage)
                if s.seconds >= _MIN_PLAUSIBLE_S and s.chars > 0
            ]
            if len(samples) >= MIN_SAMPLES:
                fit = _theil_sen([(s.chars, s.seconds) for s in samples])
                if fit is not None:
                    intercept, slope = fit
                    return max(_MIN_ESTIMATE_S, intercept + slope * max(chars, 1))
        except Exception:
            logger.warning("timing_stats.estimate(extract) failed", exc_info=True)
        return max(
            _MIN_ESTIMATE_S,
            _FALLBACK_EXTRACT_INTERCEPT_S + _FALLBACK_EXTRACT_SEC_PER_CHAR * chars,
        )

    fallback = _FALLBACK_OCR_S if stage == STAGE_OCR else _FALLBACK_MATCH_S
    if stage not in _STAGES:
        return fallback
    try:
        samples = [s for s in _recent(stage) if s.seconds >= _MIN_PLAUSIBLE_S]
        if len(samples) >= MIN_SAMPLES:
            return statistics.median(s.seconds for s in samples)
    except Exception:
        logger.warning("timing_stats.estimate(%s) failed", stage, exc_info=True)
    return fallback
