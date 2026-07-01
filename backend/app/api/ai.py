import logging
import os

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
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


@router.post("/api/extract", response_model=StandardizedMedicalRecord)
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

    client = _get_client()

    try:
        raw = extractor.extract_raw(bytes_data, file.filename, client)
    except Exception as e:
        logger.error("Extraction failed: %s", e)
        raise HTTPException(status_code=502, detail=f"OCR processing failed: {e}")

    if raw.entry_type == "unknown":
        return StandardizedMedicalRecord(
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
        )

    definitions = (
        db.query(BiomarkerDefinitionModel)
        .order_by(BiomarkerDefinitionModel.category, BiomarkerDefinitionModel.name_en)
        .all()
    )
    result = matcher.match_and_convert(raw, definitions, client)

    return result
