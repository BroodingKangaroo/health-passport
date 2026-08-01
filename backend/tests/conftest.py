import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, Request, Response
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.db.session as _db_session
from app.db.session import Base, get_db, migrate_add_columns
from app.db import models as _models  # noqa: F401  (registers tables on Base)
from tests.seed_data import seed_test_db

TEST_DATABASE_URL = "sqlite:///:memory:"


@pytest.fixture(scope="session", autouse=True)
def _seeded_shared_database():
    """The matcher tests (and a few auth tests) query the SHARED file-backed
    engine via ``SessionLocal()`` / ``app.main.app`` rather than the per-test
    in-memory engine. That DB needs real tables and the LOINC dictionary to be
    resolvable, so ensure both exist before the suite runs.

    Seeding is idempotent (insert-if-missing) and never drops existing rows,
    so a local dev DB simply gains the dictionary rows it's supposed to have.
    """
    Base.metadata.create_all(bind=_db_session.engine)
    migrate_add_columns(_db_session.engine)

    import os
    from app.db.seed_loinc import (
        LOINC_CSV,
        parse_loinc_csv,
        row_to_definition,
        dedupe_definitions,
        apply_multilingual_synonyms,
        seed_biomarkers,
    )
    if not os.path.isfile(os.path.abspath(LOINC_CSV)):
        return
    db = _db_session.SessionLocal()
    try:
        # Insert-if-missing, so a partially-seeded dev DB is completed without
        # touching existing rows.
        rows = parse_loinc_csv(os.path.abspath(LOINC_CSV))
        definitions, aliases = dedupe_definitions([row_to_definition(r) for r in rows])
        definitions = apply_multilingual_synonyms(definitions, aliases)
        seed_biomarkers(db, definitions)
        # Apply the curated reference ranges on top (idempotent).
        from app.db.import_ranges import COMMON_RANGES, merge_ranges
        merge_ranges(db, dict(COMMON_RANGES))
    finally:
        db.close()


@pytest.fixture(scope="function")
def db_session():
    # Ensure the default (file-backed) engine has any new columns added
    # by recent model changes. Safe to call on every test; no-ops when
    # the schema is already up to date. Without this, tests that use
    # ``SessionLocal()`` directly (rather than this fixture) would fail
    # on the new columns.
    migrate_add_columns(_db_session.engine)
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
