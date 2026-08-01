import asyncio
import json
import logging
import os
import time
from typing import Optional, Tuple

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from mistralai import Mistral
from mistralai.utils.retries import BackoffStrategy, RetryConfig
from sqlalchemy.orm import Session

from app.schemas.ai import StandardizedMedicalRecord, StandardizedVisitData, RawImagingData
from app.services import extractor, matcher
from app.services.usage_limits import check_and_record_ai_usage
from app.db.session import get_db, SessionLocal
from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel, Patient
from app.api.auth import get_current_user_or_anon
from config import ANONYMOUS_LIMITS, REGISTERED_LIMITS

logger = logging.getLogger(__name__)

router = APIRouter()


def _get_client() -> Optional[Mistral]:
    api_key = os.getenv("MISTRAL_API_KEY")
    if not api_key:
        return None
    # Bound the OCR/LLM requests so a slow or oversized document fails fast
    # instead of hanging the SSE stream (and the UI's "estimating..." state)
    # indefinitely. 300s gives the Files-API upload + OCR of a large phone
    # photo enough headroom (normal case is ~15s) without hanging forever.
    # retry_config makes the SDK transparently retry transient failures
    # (429 rate-limit, 5xx) with exponential backoff. Without it, a single
    # rate-limited call surfaces as a failed extraction and — because the
    # Mistral API rate-limits per account — poisons every subsequent request
    # in the same process (the documented "contamination" bug that makes
    # later e2e cases return 'unknown').
    retry_config = RetryConfig(
        strategy="backoff",
        backoff=BackoffStrategy(
            initial_interval=1000,
            max_interval=15000,
            exponent=2.0,
            max_elapsed_time=120000,
        ),
        retry_connection_errors=True,
    )
    return Mistral(api_key=api_key, timeout_ms=300_000, retry_config=retry_config)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.post("/api/extract")
async def extract_medical_data(
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    user, user_id, is_anonymous = user_data
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    # Resolve the client BEFORE consuming quota: if MISTRAL_API_KEY is missing
    # the request can never succeed, so we must not burn the user's extraction
    # count (anonymous users in particular get locked out after 5 doomed tries).
    client = _get_client()
    if client is None:
        async def error_stream():
            yield _sse("error", {"message": "AI extraction unavailable: MISTRAL_API_KEY not configured. Please add the key to backend/.env or enter data manually."})
        return StreamingResponse(error_stream(), media_type="text/event-stream")

    # Check AI extraction limit
    allowed, current_count, limit = check_and_record_ai_usage(db, user_id, is_anonymous)
    if not allowed:
        if is_anonymous:
            detail = (
                f"AI extraction limit reached ({current_count}/{limit}). "
                "Please register for higher limits."
            )
        else:
            detail = (
                f"AI extraction limit reached ({current_count}/{limit}). "
                "Consider upgrading your plan or contact support for a higher limit."
            )
        raise HTTPException(status_code=429, detail=detail)

    try:
        bytes_data = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {e}")

    if not bytes_data:
        raise HTTPException(status_code=400, detail="Empty file")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in extractor.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(extractor.ALLOWED_EXTENSIONS))}",
        )

    definitions = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.scope == "global")
        | (BiomarkerDefinitionModel.user_id == user_id)
        # System-shared local definitions (user_id IS NULL) such as curated
        # local-only analytes (e.g. "Activated lymphocytes") are available to
        # every user, including anonymous sessions, so they can be matched.
        | (BiomarkerDefinitionModel.user_id.is_(None))
    ).all()
    definitions.sort(key=lambda d: (d.category or "", d.names.get("en", "") or ""))
    # Detach definition ORM instances from the request-scoped session so their
    # already-loaded attributes are safe to read from the worker thread below.
    # SQLAlchemy Sessions are not thread-safe; matcher will use its own session.
    for d in definitions:
        db.expunge(d)

    logger.info("File: %s, size: %d bytes, type: %s, user: %s", file.filename, len(bytes_data), ext, user_id)

    async def event_stream():
        error = None
        try:
            # Stage 1: OCR
            yield _sse("progress", {"stage": "ocr_scanning"})
            t0 = time.perf_counter()
            try:
                markdown = await asyncio.to_thread(
                    extractor.ocr_document, bytes_data, ext, client
                )
            except extractor.OCRProcessingError as ocr_err:
                yield _sse("error", {"message": ocr_err.message})
                return
            elapsed = time.perf_counter() - t0
            logger.info("OCR took %.2fs — %d chars", elapsed, len(markdown) if markdown else 0)

            if not markdown:
                error = "The document was processed but no text content was found. It may contain only images or scanned signatures."
                yield _sse("error", {"message": error})
                return

            # Stage 2: LLM extraction
            yield _sse("progress", {"stage": "extracting", "markdown_chars": len(markdown)})
            t0 = time.perf_counter()
            raw = await asyncio.to_thread(extractor.llm_extract, markdown, client)
            elapsed = time.perf_counter() - t0
            bm_count = len(raw.biomarkers) if raw.biomarkers else 0
            logger.info("Extraction took %.2fs — type: %s, biomarkers: %d", elapsed, raw.entry_type, bm_count)

            if raw.entry_type == "unknown":
                yield _sse(
                    "result",
                    StandardizedMedicalRecord(
                        entry_type="unknown",
                        date=raw.date,
                        time=raw.time,
                        clinic=raw.clinic,
                        provider=raw.provider,
                        title=raw.title,
                        notes=raw.notes,
                        biomarkers=[],
                        visit_data=StandardizedVisitData(),
                        imaging_data=RawImagingData(),
                    ).model_dump(),
                )
                return

            # Stage 3: Matching
            yield _sse("progress", {"stage": "matching", "biomarker_count": bm_count})
            t0 = time.perf_counter()

            def _match_in_thread():
                # Use a thread-local Session — the request's `db` is bound to
                # the event-loop thread and must not be shared.
                thread_db = SessionLocal()
                try:
                    result = matcher.match_and_convert(raw, definitions, thread_db, user_id, client)
                    thread_db.commit()
                    return result
                except Exception:
                    thread_db.rollback()
                    raise
                finally:
                    thread_db.close()

            result = await asyncio.to_thread(_match_in_thread)
            elapsed = time.perf_counter() - t0
            std_count = len(result.biomarkers) if result.biomarkers else 0
            logger.info("Matching took %.2fs — biomarkers: %d", elapsed, std_count)

            yield _sse("result", result.model_dump())
            return

        except asyncio.CancelledError:
            raise
        except GeneratorExit:
            raise
        except Exception as e:
            logger.error("Extraction stream failed: %s", e, exc_info=True)
            error = str(e)

        if error:
            yield _sse("error", {"message": error})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            # Prevent proxies (nginx, etc.) from buffering the SSE stream so
            # progress events reach the client incrementally instead of all at once.
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
