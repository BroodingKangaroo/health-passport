from fastapi import APIRouter

from app.schemas import SaveEntryRequest, SaveEntryResponse

router = APIRouter()


@router.post("/api/entry", response_model=SaveEntryResponse)
async def save_entry(request: SaveEntryRequest):
    return SaveEntryResponse(success=True, message="Entry saved (mock)")
