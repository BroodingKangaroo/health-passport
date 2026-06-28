from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.timeline import router as timeline_router
from app.api.flowsheet import router as flowsheet_router
from app.api.entries import router as entries_router

app = FastAPI(title="HealthPassport API", version="1.0.0")

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


@app.get("/")
async def root():
    return {"message": "HealthPassport API running"}
