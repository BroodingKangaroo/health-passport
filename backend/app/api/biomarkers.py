from typing import Optional, Tuple
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.schemas.biomarker import BiomarkerDefinitionResponse
from app.db.session import get_db
from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel, Patient
from app.api.auth import get_current_user_or_anon

router = APIRouter()


@router.get("/api/biomarkers/definitions", response_model=list[BiomarkerDefinitionResponse])
async def list_definitions(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    user, user_id, is_anonymous = user_data
    defs = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.scope == "global")
        | (BiomarkerDefinitionModel.user_id == user_id)
        | (BiomarkerDefinitionModel.user_id.is_(None))
    ).all()
    defs.sort(key=lambda d: d.names.get("en", "") or "")
    return [
        BiomarkerDefinitionResponse(
            id=d.id,
            loinc_code=d.loinc_code,
            names=d.names,
            synonyms=d.synonyms or [],
            category=d.category,
            unit=d.unit,
            range_min=d.range_min,
            range_max=d.range_max,
            scope=d.scope,
            user_id=d.user_id,
            range_source=d.range_source,
        )
        for d in defs
    ]
