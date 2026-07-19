import logging
import os
from contextlib import asynccontextmanager
from typing import Optional, Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

load_dotenv()
log_file = logging.FileHandler("app.log")
log_file.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
log_file.setLevel(logging.INFO)
logging.getLogger().setLevel(logging.INFO)
logging.getLogger().addHandler(log_file)

from app.api.timeline import router as timeline_router
from app.api.flowsheet import router as flowsheet_router
from app.api.entries import router as entries_router
from app.api.ai import router as ai_router
from app.api.biomarkers import router as biomarkers_router
from app.api.auth import router as auth_router, get_current_user_or_anon
from app.api.usage_limits import router as usage_limits_router
from app.db.session import init_db, get_db
from app.db.models import Patient, Attachment as AttachmentModel, MedicalEntry as MedicalEntryModel


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="HealthPassport API", version="1.0.0", lifespan=lifespan)

cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in cors_origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(timeline_router)
app.include_router(flowsheet_router)
app.include_router(entries_router)
app.include_router(ai_router)
app.include_router(biomarkers_router)
app.include_router(auth_router)
app.include_router(usage_limits_router)

os.makedirs("static", exist_ok=True)


@app.get("/static/uploads/{file_path:path}")
async def serve_upload(
    file_path: str,
    user_data: Tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
    db: Session = Depends(get_db),
):
    from fastapi.responses import FileResponse
    user, user_id, is_anonymous = user_data
    # Validate file_path to prevent path traversal
    if not file_path or '..' in file_path or file_path.startswith('/'):
        raise HTTPException(status_code=403, detail="Forbidden")
    # Normalize and validate the path stays within uploads directory
    upload_dir = os.path.abspath("static/uploads")
    requested_path = os.path.abspath(os.path.join("static/uploads", file_path))
    # Ensure the requested path is within upload_dir
    if not requested_path.startswith(upload_dir + os.sep) and requested_path != upload_dir:
        raise HTTPException(status_code=403, detail="Forbidden")

    # Per-user authorization: confirm the file belongs to the current user (anon or registered).
    # Attachment.file_path is stored as "/static/uploads/{saved_name}" (see entries.py).
    # A file may be referenced by multiple attachment rows (e.g. after an anonymous
    # entry is migrated to a registered account, both the original anon attachment
    # and the migrated one point at the same file_path). Authorize if ANY matching
    # attachment's entry belongs to the current user.
    stored_path = f"/static/uploads/{file_path}"
    attachments = db.query(AttachmentModel).filter(
        AttachmentModel.file_path == stored_path
    ).all()
    if not attachments:
        # No attachment row tracking this file — refuse to serve.
        raise HTTPException(status_code=404, detail="File not found")
    entry_ids = {a.entry_id for a in attachments}
    owned = db.query(MedicalEntryModel).filter(
        MedicalEntryModel.id.in_(entry_ids),
        MedicalEntryModel.patient_id == user_id,
    ).first()
    if owned is None:
        raise HTTPException(status_code=403, detail="Forbidden")

    if not os.path.isfile(requested_path):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(requested_path)


@app.get("/")
async def root():
    return {"message": "HealthPassport API running"}
