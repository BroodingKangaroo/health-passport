"""The shareable read-only link: owner lifecycle and the public read surface.

Everything here runs offline against in-memory SQLite. The public routes are
reachable only through the share token header, so these tests exercise the
same path a doctor's browser takes.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
import pytest_asyncio
from fastapi import FastAPI, Request, Response
from httpx import ASGITransport, AsyncClient

from app.api.auth import get_current_user_or_anon
from app.api.auth import router as auth_router
from app.api.share import SHARE_TOKEN_HEADER, reset_public_throttle
from app.api.share import router as share_router
from app.db.models import (
    Attachment,
    BiomarkerDefinition,
    BiomarkerReading,
    MedicalEntry,
    Patient,
    ShareLink,
    UsageLimit,
)
from app.db.session import get_db
from app.i18n import MESSAGES, LocaleMiddleware
from app.services import share_links
from app.services.data_migration import copy_anonymous_data
from tests.seed_data import TEST_ANON_ID, TEST_USER_ID

DEAD_LINK_EN = MESSAGES["share.link_unavailable"]["en"]
DEAD_LINK_RU = MESSAGES["share.link_unavailable"]["ru"]


@pytest_asyncio.fixture
async def share_api(db_session):
    """App with the share router, the LocaleMiddleware and a swappable
    principal, so one test can act as the owner and then as a stranger."""
    app = FastAPI()
    app.add_middleware(LocaleMiddleware)
    app.include_router(share_router)
    # Included only for the account-deletion cascade, which lives on the auth
    # router; its own dependencies are the overridden principal.
    app.include_router(auth_router)

    principal = {"owner_id": TEST_USER_ID, "is_anonymous": False}

    async def override_get_db():
        yield db_session

    async def override_principal(request: Request, response: Response):
        owner_id = principal["owner_id"]
        user = db_session.query(Patient).filter(Patient.id == owner_id).first()
        return (user, owner_id, principal["is_anonymous"])

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user_or_anon] = override_principal
    reset_public_throttle()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, principal


async def _create_link(client) -> dict:
    resp = await client.post("/api/share/links")
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _open(client, token: str, headers: Optional[dict] = None):
    return await client.get(
        "/api/share/record",
        headers={SHARE_TOKEN_HEADER: token, **(headers or {})},
    )


async def test_create_open_revoke_is_the_whole_loop(share_api):
    client, _principal = share_api

    created = await _create_link(client)
    assert created["token"].startswith(share_links.TOKEN_PREFIX)
    assert created["scope"] == {"kind": "all"}
    assert created["include_header"] is True
    assert created["include_notes"] is False

    resp = await _open(client, created["token"])
    assert resp.status_code == 200
    body = resp.json()
    assert body["meta"]["scope"] == {"kind": "all"}
    assert body["meta"]["default_locale"] is None
    assert body["header"]["name"] == "Test User"
    assert body["header"]["dob"] == "1990-01-01"
    assert body["events"], "the seeded record should have entries"
    assert body["biomarkers"], "the seeded record should have readings"
    assert body["visits"]
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["x-robots-tag"] == "noindex, nofollow"

    revoked = await client.post(f"/api/share/links/{created['id']}/revoke")
    assert revoked.status_code == 200

    after = await _open(client, created["token"])
    assert after.status_code == 404
    assert after.json()["detail"] == DEAD_LINK_EN


async def test_attachments_never_travel(share_api, db_session):
    client, _principal = share_api
    created = await _create_link(client)
    body = (await _open(client, created["token"])).json()

    # The seed gives at least one entry a real attachment row, so empty lists
    # below are the exclusion working rather than an empty fixture.
    assert db_session.query(Attachment).count() > 0
    assert all(event["attachments"] == [] for event in body["events"])
    assert all(visit["attachments"] == [] for visit in body["visits"].values())
    assert all(item["attachments"] == [] for item in body["instrumental"].values())


async def test_dead_links_are_indistinguishable(share_api, db_session):
    client, _principal = share_api
    created = await _create_link(client)
    await client.post(f"/api/share/links/{created['id']}/revoke")

    expired_token = "hp_expired-token-that-was-once-real"
    db_session.add(
        ShareLink(
            id="expired-row",
            token_hash=share_links.hash_token(expired_token),
            owner_id=TEST_USER_ID,
            is_anonymous=False,
            include_header=True,
            include_notes=False,
            created_at=datetime.now(timezone.utc) - timedelta(days=10),
            expires_at=datetime.now(timezone.utc) - timedelta(days=3),
        )
    )
    db_session.commit()

    responses = [
        await client.get("/api/share/record"),
        await _open(client, "hp_never-issued-at-all"),
        await _open(client, created["token"]),
        await _open(client, expired_token),
    ]
    assert {r.status_code for r in responses} == {404}
    assert len({r.text for r in responses}) == 1


async def test_dead_link_is_localized(share_api):
    client, _principal = share_api
    english = await _open(client, "hp_not-a-real-token")
    russian = await _open(
        client, "hp_not-a-real-token", {"Accept-Language": "ru-RU,ru;q=0.9"}
    )
    assert english.json()["detail"] == DEAD_LINK_EN
    assert russian.json()["detail"] == DEAD_LINK_RU


async def test_token_is_stored_hashed_and_never_re_displayed(share_api, db_session):
    client, _principal = share_api
    created = await _create_link(client)

    row = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).one()
    assert row.token_hash == share_links.hash_token(created["token"])
    stored = {c.name: getattr(row, c.name) for c in row.__table__.columns}
    assert created["token"] not in str(stored)

    listed = (await client.get("/api/share/links")).json()["links"]
    assert [link["id"] for link in listed] == [created["id"]]
    assert "token" not in listed[0]


async def test_first_open_is_recorded_once(share_api, db_session):
    client, _principal = share_api
    created = await _create_link(client)
    link_id = created["id"]

    assert db_session.query(ShareLink).filter(ShareLink.id == link_id).one().first_opened_at is None
    assert (await client.get("/api/share/links")).json()["links"][0]["first_opened_at"] is None

    await _open(client, created["token"])
    db_session.expire_all()
    first = db_session.query(ShareLink).filter(ShareLink.id == link_id).one().first_opened_at
    assert first is not None

    await _open(client, created["token"])
    db_session.expire_all()
    again = db_session.query(ShareLink).filter(ShareLink.id == link_id).one().first_opened_at
    assert again == first


async def test_links_never_leak_across_principals(share_api, db_session):
    client, principal = share_api

    db_session.add(
        MedicalEntry(
            id="anon-visit",
            patient_id=TEST_ANON_ID,
            type="doctor_visit",
            date=datetime(2025, 3, 3, tzinfo=timezone.utc),
            title="Anonymous visit",
        )
    )
    db_session.commit()

    principal.update(owner_id=TEST_ANON_ID, is_anonymous=True)
    anon_link = await _create_link(client)
    principal.update(owner_id=TEST_USER_ID, is_anonymous=False)
    user_link = await _create_link(client)

    anon_body = (await _open(client, anon_link["token"])).json()
    user_body = (await _open(client, user_link["token"])).json()

    assert [event["id"] for event in anon_body["events"]] == ["anon-visit"]
    assert anon_body["biomarkers"] == []
    assert anon_body["header"] is None
    assert "anon-visit" not in [event["id"] for event in user_body["events"]]
    assert user_body["biomarkers"]
    assert user_body["header"]["name"] == "Test User"


async def test_manage_routes_are_owner_scoped(share_api):
    client, principal = share_api
    created = await _create_link(client)

    principal.update(owner_id=TEST_ANON_ID, is_anonymous=True)
    assert (await client.get("/api/share/links")).json()["links"] == []
    assert (await client.post(f"/api/share/links/{created['id']}/revoke")).status_code == 404
    # The owner's link survives the stranger's failed revoke.
    assert (await _open(client, created["token"])).status_code == 200


async def test_revoke_all_touches_only_the_callers_links(share_api):
    client, principal = share_api
    first = await _create_link(client)
    second = await _create_link(client)

    principal.update(owner_id=TEST_ANON_ID, is_anonymous=True)
    anon_link = await _create_link(client)
    assert (await client.post("/api/share/links/revoke-all")).json()["revoked"] == 1
    assert (await _open(client, anon_link["token"])).status_code == 404

    principal.update(owner_id=TEST_USER_ID, is_anonymous=False)
    assert (await _open(client, first["token"])).status_code == 200
    assert (await _open(client, second["token"])).status_code == 200


async def test_revoke_is_idempotent(share_api):
    client, _principal = share_api
    created = await _create_link(client)
    for _ in range(2):
        assert (await client.post(f"/api/share/links/{created['id']}/revoke")).status_code == 200


async def test_account_deletion_removes_links(share_api, db_session):
    client, _principal = share_api
    created = await _create_link(client)

    deleted = await client.delete("/api/auth/account")
    assert deleted.status_code == 200
    assert db_session.query(ShareLink).filter(ShareLink.id == created["id"]).count() == 0
    assert (await _open(client, created["token"])).status_code == 404


async def test_register_migration_rekeys_links(share_api, db_session):
    client, principal = share_api
    principal.update(owner_id=TEST_ANON_ID, is_anonymous=True)
    created = await _create_link(client)

    db_session.add(
        Patient(
            id="newly-registered",
            email="newly-registered@example.com",
            hashed_password="not-a-real-hash",
            name="Newly Registered",
            dob="",
            gender="",
            external_id="HP-TEST-0002",
        )
    )
    db_session.commit()

    summary = copy_anonymous_data(db_session, TEST_ANON_ID, "newly-registered")
    assert summary["share_links_migrated"] == 1

    db_session.expire_all()
    row = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).one()
    assert row.owner_id == "newly-registered"
    assert row.is_anonymous is False
    # The link keeps working, now over the registered record.
    assert (await _open(client, created["token"])).status_code == 200


async def test_merged_readings_are_excluded(share_api, db_session):
    client, _principal = share_api
    created = await _create_link(client)
    before = (await _open(client, created["token"])).json()
    before_hb = next(b for b in before["biomarkers"] if b["definition"]["id"] == "hb")

    # A reading merged in by a later upload is the newest hb value — exactly
    # what the shared view must not present (D15).
    db_session.add(
        MedicalEntry(
            id="blood-merged",
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=datetime(2026, 1, 1, tzinfo=timezone.utc),
            title="Later upload",
        )
    )
    db_session.add(
        BiomarkerReading(
            entry_id="blood-merged",
            biomarker_id="hb",
            value=999.0,
            reference={"kind": "interval", "low": 12.0, "high": 16.0},
            status="high",
            merged=True,
        )
    )
    db_session.commit()

    after = (await _open(client, created["token"])).json()
    after_hb = next(b for b in after["biomarkers"] if b["definition"]["id"] == "hb")
    assert after_hb["value"] == before_hb["value"]
    assert after_hb["merged"] is False
    assert not any(
        reading["merged"] for b in after["biomarkers"] for reading in b["history"]
    )
    # The record is still live: the added entry moves the "last updated" stamp.
    assert after["meta"]["last_updated"] != before["meta"]["last_updated"]


async def test_inferred_unit_flag_is_dropped(share_api, db_session):
    client, _principal = share_api
    definition = (
        db_session.query(BiomarkerDefinition)
        .filter(BiomarkerDefinition.id == "wbc")
        .one()
    )
    definition.canonical_unit_inferred = True
    db_session.commit()

    created = await _create_link(client)
    body = (await _open(client, created["token"])).json()
    assert body["biomarkers"]
    assert all(
        "canonical_unit_inferred" not in b["definition"] for b in body["biomarkers"]
    )


async def test_shared_flowsheet_serves_the_same_record(share_api):
    client, _principal = share_api
    created = await _create_link(client)
    resp = await client.get(
        "/api/share/flowsheet", headers={SHARE_TOKEN_HEADER: created["token"]}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dates"]
    assert body["matrix"]
    assert body["biomarkers"]
    assert resp.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
async def test_public_paths_are_get_only(share_api, method):
    client, _principal = share_api
    for path in ("/api/share/record", "/api/share/flowsheet"):
        resp = await getattr(client, method)(path)
        assert resp.status_code == 405, f"{method.upper()} {path} -> {resp.status_code}"


async def test_scope_and_tenant_parameters_cannot_widen_a_link(share_api):
    """The public routes take no tenant id and no scope, so smuggled query
    parameters change nothing."""
    client, _principal = share_api
    created = await _create_link(client)
    plain = (await _open(client, created["token"])).json()
    tampered = (
        await client.get(
            "/api/share/record",
            params={
                "patient_id": TEST_ANON_ID,
                "owner_id": TEST_ANON_ID,
                "from": "2099-01-01",
                "to": "2099-12-31",
                "include_notes": "true",
            },
            headers={SHARE_TOKEN_HEADER: created["token"]},
        )
    ).json()
    assert tampered["meta"]["scope"] == {"kind": "all"}
    assert [e["id"] for e in tampered["events"]] == [e["id"] for e in plain["events"]]


async def test_public_read_mints_no_session_or_usage(share_api, db_session):
    """A recipient is a stranger: no anonymous session, no usage row, no cookie
    — the share token is the only credential on the public path."""
    client, _principal = share_api
    created = await _create_link(client)
    before = db_session.query(UsageLimit).count()

    resp = await _open(client, created["token"])
    assert resp.status_code == 200
    assert "set-cookie" not in {key.lower() for key in resp.headers}
    assert db_session.query(UsageLimit).count() == before


def test_public_throttle_drops_stale_ip_windows():
    """The limiter is keyed by client IP on an unauthenticated route, so a
    window whose entries have aged out must not keep its map entry alive."""
    from app.api import share as share_api

    share_api.reset_public_throttle()
    now = datetime.now(timezone.utc).timestamp()
    with share_api._public_lock:
        share_api._public_windows["10.0.0.1"].append(
            now - share_api._PUBLIC_READ_WINDOW_S - 1
        )
        share_api._public_windows["10.0.0.2"].append(now)

    share_api._prune_public_keys()

    assert "10.0.0.1" not in share_api._public_windows
    assert "10.0.0.2" in share_api._public_windows


def test_public_throttle_map_is_capped():
    """A burst of distinct IPs inside one window must not grow the map past the
    cap — the least-recently-active windows are evicted instead."""
    from app.api import share as share_api

    share_api.reset_public_throttle()
    now = datetime.now(timezone.utc).timestamp()
    over_by = 50
    with share_api._public_lock:
        for i in range(share_api._PUBLIC_MAX_KEYS + over_by):
            # Descending timestamps ⇒ the last-inserted keys are the stalest.
            share_api._public_windows[f"ip-{i}"].append(now - i * 0.001)

    share_api._prune_public_keys()

    assert len(share_api._public_windows) == share_api._PUBLIC_MAX_KEYS
    # The freshest window survived; the stalest were dropped.
    assert "ip-0" in share_api._public_windows
    assert f"ip-{share_api._PUBLIC_MAX_KEYS + over_by - 1}" not in share_api._public_windows
