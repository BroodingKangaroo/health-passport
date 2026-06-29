import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base, get_db
from app.db.seed import seed_db

TEST_DATABASE_URL = "sqlite:///:memory:"


@pytest.fixture(scope="function")
def db_session():
    engine = create_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    seed_db(session)

    yield session

    session.close()
    Base.metadata.drop_all(bind=engine)


@pytest_asyncio.fixture
async def client(db_session):
    from app.api.timeline import router as timeline_router
    from app.api.flowsheet import router as flowsheet_router
    from app.api.entries import router as entries_router

    app = FastAPI()
    app.include_router(timeline_router)
    app.include_router(flowsheet_router)
    app.include_router(entries_router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
