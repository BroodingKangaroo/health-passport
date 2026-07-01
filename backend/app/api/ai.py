import asyncio
import json
import logging
import os
import time

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from fastapi.responses import StreamingResponse
from mistralai import Mistral
from sqlalchemy.orm import Session

from app.schemas.ai import StandardizedMedicalRecord
from app.services import extractor, matcher
from app.db.session import get_db
from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel

logger = logging.getLogger(__name__)

router = APIRouter()


def _get_client() -> Mistral:
    api_key = os.getenv("MISTRAL_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="MISTRAL_API_KEY not configured")
    return Mistral(api_key=api_key)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.post("/api/extract")
async def extract_medical_data(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

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

    definitions = (
        db.query(BiomarkerDefinitionModel)
        .order_by(BiomarkerDefinitionModel.category, BiomarkerDefinitionModel.name_en)
        .all()
    )

    client = _get_client()

    async def event_stream():
        error = None
        try:
            # Stage 1: OCR
            yield _sse("progress", {"stage": "ocr_scanning"})
            t0 = time.perf_counter()
            markdown = await asyncio.to_thread(
                extractor.ocr_document, bytes_data, client
            )
            elapsed = time.perf_counter() - t0
            logger.info("OCR took %.2fs", elapsed)

            if markdown is None:
                yield _sse(
                    "result",
                    StandardizedMedicalRecord(
                        entry_type="unknown",
                        notes="The uploaded document appears to contain images that cannot be processed.",
                    ).model_dump(),
                )
                return
            if not markdown:
                yield _sse(
                    "result",
                    StandardizedMedicalRecord(
                        entry_type="unknown",
                        notes="OCR returned no text content",
                    ).model_dump(),
                )
                return

            # Stage 2: LLM extraction
            yield _sse("progress", {"stage": "extracting"})
            t0 = time.perf_counter()
            raw = await asyncio.to_thread(extractor.llm_extract, markdown, client)
            elapsed = time.perf_counter() - t0
            logger.info("Extraction took %.2fs", elapsed)

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
                        biomarkers=raw.biomarkers,
                        visit_data=raw.visit_data,
                        imaging_data=raw.imaging_data,
                    ).model_dump(),
                )
                return

            # Stage 3: Matching
            yield _sse("progress", {"stage": "matching"})
            t0 = time.perf_counter()
            result = await asyncio.to_thread(
                matcher.match_and_convert, raw, definitions, client
            )
            elapsed = time.perf_counter() - t0
            logger.info("Matching took %.2fs", elapsed)

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

    return StreamingResponse(event_stream(), media_type="text/event-stream")
