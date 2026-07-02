import logging
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

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
from app.db.session import init_db, SessionLocal
from app.db.seed import seed_db

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    db = SessionLocal()
    try:
        pass  # seed_db(db)
    finally:
        db.close()
    yield


app = FastAPI(title="HealthPassport API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(timeline_router)
app.include_router(flowsheet_router)
app.include_router(entries_router)
app.include_router(ai_router)
app.include_router(biomarkers_router)

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return {"message": "HealthPassport API running"}
