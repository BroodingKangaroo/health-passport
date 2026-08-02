from typing import Optional

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.api._serializers import definition_schema
from app.api.auth import get_current_user_or_anon
from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.db.models import Patient
from app.db.session import get_db
from app.schemas.biomarker import BiomarkerDefinitionResponse

router = APIRouter()


@router.get("/api/biomarkers/definitions", response_model=list[BiomarkerDefinitionResponse])
async def list_definitions(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon)
):
    _user, user_id, _is_anonymous = user_data
    defs = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.scope == "global")
        | (BiomarkerDefinitionModel.user_id == user_id)
        | (BiomarkerDefinitionModel.user_id.is_(None))
    ).all()
    defs.sort(key=lambda d: d.names.get("en", "") or "")
    return [definition_schema(d) for d in defs]
