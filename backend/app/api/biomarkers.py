from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.schemas.biomarker import BiomarkerDefinitionResponse
from app.db.session import get_db
from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel

router = APIRouter()


@router.get("/api/biomarkers/definitions", response_model=list[BiomarkerDefinitionResponse])
async def list_definitions(db: Session = Depends(get_db)):
    defs = db.query(BiomarkerDefinitionModel).order_by(BiomarkerDefinitionModel.name_en).all()
    return [
        BiomarkerDefinitionResponse(
            id=d.id,
            name_en=d.name_en,
            name_ru=d.name_ru,
            name_es=d.name_es,
            name_de=d.name_de,
            name_fr=d.name_fr,
            name_he=d.name_he,
            category=d.category,
            unit=d.unit,
            range_min=d.range_min,
            range_max=d.range_max,
        )
        for d in defs
    ]
