"""Localization of user-facing backend strings (app/i18n.py).

Covers the Accept-Language resolution rules and the end-to-end behavior:
with no header the API returns the exact legacy English strings; with
``Accept-Language: ru`` the same endpoints return Russian.
"""

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.auth import router as auth_router
from app.api.entries import router as entries_router
from app.db.session import get_db
from app.i18n import MESSAGES, LocaleMiddleware, resolve_locale, tr, tr_opt


@pytest.mark.parametrize(
    "header,expected",
    [
        (None, "en"),
        ("", "en"),
        ("en", "en"),
        ("en-US,en;q=0.9", "en"),
        ("ru", "ru"),
        ("ru-RU,ru;q=0.9,en;q=0.8", "ru"),
        ("RU", "ru"),
        # Unsupported languages fall back to English.
        ("fr-FR,fr;q=0.9", "en"),
        # q-values decide between supported locales.
        ("en;q=0.5, ru;q=0.9", "ru"),
        ("en;q=0.9, ru;q=0.5", "en"),
        # q=0 means "not acceptable".
        ("ru;q=0", "en"),
        # Garbage falls back to English.
        ("*;q=1.0", "en"),
        ("%%$,", "en"),
    ],
)
def test_resolve_locale(header, expected):
    assert resolve_locale(header) == expected


def test_catalog_is_bilingual():
    for key, entry in MESSAGES.items():
        assert set(entry.keys()) >= {"en", "ru"}, f"{key} missing a locale"
        assert entry["en"], f"{key} has an empty English string"
        assert entry["ru"], f"{key} has an empty Russian string"


def test_tr_unknown_key_raises():
    with pytest.raises(KeyError):
        tr("no.such_key")


def test_tr_opt_unknown_key_returns_none():
    assert tr_opt("no.such_key") is None


def test_tr_english_fallback_for_unknown_locale():
    # current_locale() defaults to 'en' outside a request.
    assert tr("ai.empty_file") == "Empty file"


@pytest.fixture
async def i18n_client():
    """Bare app WITH the LocaleMiddleware (the default ``client`` fixture
    builds one without it, so Accept-Language would be ignored there).

    Uses its own in-memory engine with StaticPool: conftest's ``db_session``
    relies on the default sqlite :memory: pooling, which gives the worker
    thread that runs SYNC endpoints (like ``login``) a fresh, empty database.
    StaticPool pins one shared connection so sync and async endpoints see the
    same seeded tables.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.db.models import Base  # noqa: F401  (registers tables on Base)
    from app.db.session import Base as _Base
    from tests.seed_data import seed_test_db

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    _Base.metadata.create_all(bind=engine)
    session = TestingSessionLocal()
    seed_test_db(session)

    app = FastAPI()
    app.add_middleware(LocaleMiddleware)
    app.include_router(auth_router)
    app.include_router(entries_router)

    async def override_get_db():
        yield session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    session.close()
    _Base.metadata.drop_all(bind=engine)


async def _login(i18n_client, headers=None):
    return await i18n_client.post(
        "/api/auth/login",
        data={"username": "nobody@example.com", "password": "wrong"},
        headers=headers or {},
    )


async def test_no_header_keeps_legacy_english(i18n_client):
    resp = await _login(i18n_client)
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Incorrect email or password"


async def test_russian_login_error(i18n_client):
    resp = await _login(i18n_client, headers={"Accept-Language": "ru-RU,ru;q=0.9"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Неверный email или пароль"


async def test_russian_register_short_password(i18n_client):
    resp = await i18n_client.post(
        "/api/auth/register",
        json={"email": "ru-test@example.com", "password": "short", "name": "Тест"},
        headers={"Accept-Language": "ru"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Пароль должен содержать не менее 8 символов"


async def test_russian_entry_not_found(i18n_client):
    resp = await i18n_client.delete(
        "/api/entry/does-not-exist",
        headers={"Accept-Language": "ru"},
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Запись 'does-not-exist' не найдена"


async def test_english_entry_not_found(i18n_client):
    resp = await i18n_client.delete("/api/entry/does-not-exist")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Entry 'does-not-exist' not found"
