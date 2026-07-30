import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, Request, Response
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

import app.db.session as _db_session
from app.db.session import Base, get_db
from app.db import models as _models  # noqa: F401  (registers tables on Base)
from tests.seed_data import seed_test_db

TEST_DATABASE_URL = "sqlite:///:memory:"


def _migrate_add_columns(engine) -> None:
    """Idempotent in-place schema migration for the default (file-backed)
    engine. Adds any columns the model declares that the existing DB
    doesn't yet have. This matters whenever a new column is added to a
    model — SQLAlchemy's ``create_all`` only creates missing tables, not
    missing columns on existing tables, so legacy test DBs (and
    long-lived user DBs) would otherwise fall behind the schema.
    """
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                # Build a portable CREATE COLUMN clause. Use the column's
                # compiled type so defaults / nullability are preserved.
                col_type = col.type.compile(engine.dialect)
                nullable = "" if col.nullable else " NOT NULL"
                default = ""
                if col.default is not None and col.default.is_scalar:
                    default = f" DEFAULT {col.default.arg!r}"
                conn.execute(text(
                    f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col_type}{nullable}{default}"
                ))


@pytest.fixture(scope="function")
def db_session():
    # Ensure the default (file-backed) engine has any new columns added
    # by recent model changes. Safe to call on every test; no-ops when
    # the schema is already up to date. Without this, tests that use
    # ``SessionLocal()`` directly (rather than this fixture) would fail
    # on the new columns.
    _migrate_add_columns(_db_session.engine)
    # The fixture itself uses a fresh in-memory engine so the per-test
    # ``drop_all`` at teardown only nukes the in-memory DB, not the
    # shared file-backed DB that other tests may query directly.
    engine = create_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    session = TestingSessionLocal()
    seed_test_db(session)
    yield session
    session.close()
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def auth_token(db_session):
    from app.auth import create_access_token
    from tests.seed_data import TEST_USER_ID, TEST_USER_EMAIL
    return create_access_token(data={"sub": TEST_USER_ID, "email": TEST_USER_EMAIL})


@pytest_asyncio.fixture
async def client(db_session, auth_token):
    from app.api.timeline import router as timeline_router
    from app.api.flowsheet import router as flowsheet_router
    from app.api.entries import router as entries_router
    from app.api.ai import router as ai_router
    from app.api.biomarkers import router as biomarkers_router
    from app.api.auth import get_current_user, get_current_user_or_anon
    from app.api.usage_limits import router as usage_limits_router
    from app.db.models import Patient
    from tests.seed_data import TEST_USER_ID, TEST_USER_EMAIL

    app = FastAPI()
    app.include_router(timeline_router)
    app.include_router(flowsheet_router)
    app.include_router(entries_router)
    app.include_router(ai_router)
    app.include_router(biomarkers_router)
    app.include_router(usage_limits_router)

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        from app.db.models import Patient
        user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
        if not user:
            from app.auth import create_user
            user = create_user(db_session, TEST_USER_EMAIL, "testpassword123", "Test User", "1990-01-01", "Other")
            db_session.commit()
        return user

    async def override_get_current_user_or_anon(request: Request, response: Response):
        # For tests, we'll use the authenticated user by default
        user = db_session.query(Patient).filter(Patient.id == TEST_USER_ID).first()
        if not user:
            from app.auth import create_user
            user = create_user(db_session, TEST_USER_EMAIL, "testpassword123", "Test User", "1990-01-01", "Other")
            db_session.commit()
        return (user, user.id, False)

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[get_current_user_or_anon] = override_get_current_user_or_anon

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
