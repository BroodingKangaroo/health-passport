"""Rolling per-stage extraction timing stats.

Every `/api/extract` run already measures its OCR / LLM-extraction / matching
durations for logging; these samples are persisted here (pruned to the last N
per stage) so the SSE `progress` events can carry an `estimate_s` that tracks
*current* provider latency. LLM latency drifts heavily over time (the same
blood test went from ~22s to ~10s of extraction within weeks), so estimates
come from the median of recent samples rather than baked-in constants.

Cold start (fewer than MIN_SAMPLES for a stage) falls back to static
constants fitted from historical app.log data until real samples accumulate.
"""

import logging
import math
import statistics

from sqlalchemy import delete, select

from app.db.models import ExtractionTimingSample
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

STAGE_OCR = "ocr"
STAGE_EXTRACT = "extract"
STAGE_MATCH = "match"
_STAGES = (STAGE_OCR, STAGE_EXTRACT, STAGE_MATCH)

# Samples kept per stage: large enough for a stable median, small enough
# that the estimate re-adapts within a handful of runs after latency drifts.
MAX_SAMPLES = 20
# Below this many samples the median is too noisy — use the fallback constants.
MIN_SAMPLES = 5

# Cold-start constants (seconds), fitted from recent app.log history:
# OCR ≈ 0.8–2.5s flat; extraction ≈ 2s + ~0.003 s/char; matching ≈ 2.5–3.5s
# flat (weak biomarker-count dependence).
_FALLBACK_OCR_S = 1.5
_FALLBACK_EXTRACT_INTERCEPT_S = 2.0
_FALLBACK_EXTRACT_SEC_PER_CHAR = 0.003
_FALLBACK_MATCH_S = 3.5


def record(stage: str, seconds: float, chars: int = 0) -> None:
    """Persist one completed stage duration and prune old samples.

    Best-effort: called from the SSE generator after each stage, so any
    failure here must never break the extraction stream.
    """
    if stage not in _STAGES or not math.isfinite(seconds) or seconds < 0:
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


def estimate(stage: str, chars: int = 0) -> float:
    """Estimated seconds for `stage` (with `chars` of markdown for extract).

    Median of the recent per-character ratios for the extract stage (so the
    estimate scales with document size); flat median for ocr/match. Falls
    back to the fitted constants until MIN_SAMPLES real samples exist.
    """
    if stage == STAGE_EXTRACT:
        try:
            samples = _recent(stage)
            if len(samples) >= MIN_SAMPLES:
                ratios = [s.seconds / s.chars for s in samples if s.chars > 0]
                if ratios:
                    return max(2.0, statistics.median(ratios) * max(chars, 1))
        except Exception:
            logger.warning("timing_stats.estimate(extract) failed", exc_info=True)
        return max(
            2.0,
            _FALLBACK_EXTRACT_INTERCEPT_S + _FALLBACK_EXTRACT_SEC_PER_CHAR * chars,
        )

    fallback = _FALLBACK_OCR_S if stage == STAGE_OCR else _FALLBACK_MATCH_S
    if stage not in _STAGES:
        return fallback
    try:
        samples = _recent(stage)
        if len(samples) >= MIN_SAMPLES:
            return statistics.median(s.seconds for s in samples)
    except Exception:
        logger.warning("timing_stats.estimate(%s) failed", stage, exc_info=True)
    return fallback
