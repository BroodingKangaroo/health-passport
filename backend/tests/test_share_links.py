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
    InstrumentalData,
    MedicalEntry,
    Patient,
    ShareFunnelEvent,
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
    # Entry notes never travel, so the toggle is not even on the wire (S3).
    assert "include_notes" not in created

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


# ---------------------------------------------------------------------------
# Stage 2 — the sender controls the link (scope, expiry, revoke) and is told
# when new data has become visible through it.
# ---------------------------------------------------------------------------

SCOPE_FROM = "2024-05-01"
SCOPE_TO = "2024-09-10"
# Seed facts the scope assertions lean on (tests/seed_data.py):
#   blood tests 2024-02-18 … 2025-01-12, visits 2024-08-22 / 2024-09-05 /
#   2024-10-18, procedure 2024-09-12. Inside SCOPE_FROM..SCOPE_TO that is
#   blood-may, blood-jun, blood-aug, ortho and cardio.
IN_WINDOW_ENTRIES = ["blood-may", "blood-jun", "blood-aug", "ortho", "cardio"]
OUT_OF_WINDOW_ENTRIES = {
    "blood-feb", "blood-sep", "blood-oct", "blood-oct-eve", "blood-dec",
    "blood-jan", "neuro", "derm",
}


def _at(day: str, **kwargs) -> datetime:
    return datetime.fromisoformat(day).replace(tzinfo=timezone.utc, **kwargs)


async def _create(client, **body) -> dict:
    """Create a link, optionally with a create body (S4-S6)."""
    resp = await client.post("/api/share/links", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _link_row(db, link_id: str) -> ShareLink:
    db.expire_all()
    return db.query(ShareLink).filter(ShareLink.id == link_id).one()


def _funnel(db) -> list[ShareFunnelEvent]:
    db.expire_all()
    return db.query(ShareFunnelEvent).order_by(ShareFunnelEvent.id).all()


async def test_expiry_is_validated_per_principal_and_localized(share_api):
    """S4: the registered sender gets 1/7/30, the anonymous sender 1/7, and
    the refusal is server-side and localized — not a hidden UI rule."""
    client, principal = share_api

    for days in (1, 7, 30):
        created = await _create(client, expiry_days=days)
        window = (
            datetime.fromisoformat(created["expires_at"])
            - datetime.fromisoformat(created["created_at"])
        )
        assert abs(window - timedelta(days=days)) < timedelta(minutes=1)

    refused = await client.post("/api/share/links", json={"expiry_days": 2})
    assert refused.status_code == 400
    assert refused.json()["detail"] == MESSAGES["share.expiry_not_allowed"]["en"].format(
        allowed="1, 7, 30"
    )
    refused_ru = await client.post(
        "/api/share/links",
        json={"expiry_days": 2},
        headers={"Accept-Language": "ru-RU,ru;q=0.9"},
    )
    assert refused_ru.json()["detail"] == MESSAGES["share.expiry_not_allowed"]["ru"].format(
        allowed="1, 7, 30"
    )

    principal.update(owner_id=TEST_ANON_ID, is_anonymous=True)
    for days in (1, 7):
        await _create(client, expiry_days=days)
    anon_30 = await client.post("/api/share/links", json={"expiry_days": 30})
    assert anon_30.status_code == 400
    assert anon_30.json()["detail"] == MESSAGES["share.expiry_not_allowed"]["en"].format(
        allowed="1, 7"
    )
    anon_30_ru = await client.post(
        "/api/share/links",
        json={"expiry_days": 30},
        headers={"Accept-Language": "ru"},
    )
    assert anon_30_ru.json()["detail"] == MESSAGES["share.expiry_not_allowed"]["ru"].format(
        allowed="1, 7"
    )

    # The refusals created nothing: the anonymous sender's history is the two
    # accepted links.
    links = (await client.get("/api/share/links")).json()["links"]
    assert len(links) == 2
    assert all(link["is_anonymous"] for link in links)


async def test_scope_is_validated_on_create_and_localized(share_api):
    """S5: unknown kinds, unparseable dates and an inverted range are 400s."""
    client, _principal = share_api

    rejected = [
        ({"kind": "week"}, "share.scope_unknown_kind"),
        ({"not": "a scope"}, "share.scope_unknown_kind"),
        (
            {"kind": "range", "from": "05/01/2024"},
            "share.scope_invalid_date",
        ),
        ({"kind": "range", "to": ""}, "share.scope_invalid_date"),
        (
            {"kind": "range", "from": "2024-06-01", "to": "2024-05-01"},
            "share.scope_invalid_range",
        ),
    ]
    for body, key in rejected:
        resp = await client.post("/api/share/links", json={"scope": body})
        assert resp.status_code == 400, (body, resp.text)
        assert resp.json()["detail"] == MESSAGES[key]["en"], body

    localized = await client.post(
        "/api/share/links",
        json={"scope": {"kind": "week"}},
        headers={"Accept-Language": "ru"},
    )
    assert localized.json()["detail"] == MESSAGES["share.scope_unknown_kind"]["ru"]

    ranged = await _create(client, scope={"kind": "range", "from": SCOPE_FROM, "to": SCOPE_TO})
    assert ranged["scope"] == {"kind": "range", "from": SCOPE_FROM, "to": SCOPE_TO}
    open_ended = await _create(client, scope={"kind": "range", "from": SCOPE_FROM})
    assert open_ended["scope"] == {"kind": "range", "from": SCOPE_FROM, "to": None}
    whole = await _create(client, scope={"kind": "all"})
    assert whole["scope"] == {"kind": "all"}


async def test_scope_narrows_every_section(share_api, db_session):
    """S5: flags, trends, visits, instrumental data, the full table and the
    flowsheet columns all follow one window — and a reading whose entry is
    outside it never reappears inside another entry's history."""
    client, _principal = share_api

    # The seed carries no instrumental data, so an empty dict would not prove
    # the filter ran: add one study inside the window and one outside it.
    for entry_id, day in (("mri-out", "2024-10-01"), ("mri-in", "2024-06-15")):
        db_session.add(
            MedicalEntry(
                id=entry_id,
                patient_id=TEST_USER_ID,
                type="instrumental",
                date=_at(day),
                title=entry_id,
            )
        )
        db_session.add(
            InstrumentalData(
                entry_id=entry_id,
                modality="MRI",
                findings=f"{entry_id} findings",
                conclusion=f"{entry_id} conclusion",
            )
        )
    db_session.commit()

    created = await _create(client, scope={"kind": "range", "from": SCOPE_FROM, "to": SCOPE_TO})
    body = (await _open(client, created["token"])).json()

    # meta reports the real scope (never the all-record default).
    assert body["meta"]["scope"] == {"kind": "range", "from": SCOPE_FROM, "to": SCOPE_TO}

    # 1. the full table (ordered by entry date, so the added study sits in the
    # middle of the seeded ones)
    assert [e["id"] for e in body["events"]] == [
        "blood-may", "mri-in", "blood-jun", "blood-aug", "ortho", "cardio",
    ]
    assert set(IN_WINDOW_ENTRIES) <= set(e["id"] for e in body["events"])
    assert OUT_OF_WINDOW_ENTRIES.isdisjoint(e["id"] for e in body["events"])
    assert "mri-out" not in [e["id"] for e in body["events"]]

    # 2. flags (the biomarker list) and 3. trends (its history)
    assert {b["entry_id"] for b in body["biomarkers"]} <= {
        "blood-may", "blood-jun", "blood-aug"
    }
    wbc = next(b for b in body["biomarkers"] if b["definition"]["id"] == "wbc")
    assert wbc["value"] == 5.5
    assert wbc["date"].startswith("2024-08-10")
    assert [r["date"][:10] for r in wbc["history"]] == ["2024-05-05", "2024-06-28"]
    assert {r["entry_id"] for r in wbc["history"]} == {"blood-may", "blood-jun"}
    # The out-of-window readings are gone from every series, not just the head.
    assert all(
        r["date"][:10] <= SCOPE_TO for b in body["biomarkers"] for r in b["history"]
    )

    # 4. visits
    assert set(body["visits"]) == {"cardio", "ortho"}

    # 5. instrumental data
    assert set(body["instrumental"]) == {"mri-in"}
    assert body["instrumental"]["mri-in"]["modality"] == "MRI"

    # 6. the flowsheet's columns, cells and rows
    flowsheet = (
        await client.get(
            "/api/share/flowsheet", headers={SHARE_TOKEN_HEADER: created["token"]}
        )
    ).json()
    assert len(flowsheet["dates"]) == 3
    labels = [d["label"] for d in flowsheet["dates"]]
    assert labels[0].startswith("May 05")
    assert labels[1].startswith("Jun 28")
    assert labels[2].startswith("Aug 10")
    assert {b["entry_id"] for b in flowsheet["biomarkers"]} == {
        "blood-may", "blood-jun", "blood-aug"
    }
    cells = [
        row for category in flowsheet["matrix"] for row in category["rows"] if row["id"] == "wbc"
    ]
    assert len(cells) == 1
    assert [cell["value"] for cell in cells[0]["cells"]] == ["5.0", "15.8", "5.5"]


async def test_scope_open_ended_range_keeps_everything_after_the_start(share_api):
    client, _principal = share_api
    created = await _create(client, scope={"kind": "range", "from": "2024-09-01"})
    body = (await _open(client, created["token"])).json()
    ids = [e["id"] for e in body["events"]]
    # Later entries survive, the ones before the start do not.
    assert "neuro" in ids and "derm" in ids and "blood-sep" in ids
    assert "blood-feb" not in ids and "blood-may" not in ids
    assert body["meta"]["scope"] == {"kind": "range", "from": "2024-09-01", "to": None}


async def test_open_counters_are_debounced(share_api, db_session):
    """S2: one debounced conditional UPDATE counts a visit, stamps the first
    open once and records the record watermark the recipient could see."""
    client, _principal = share_api
    created = await _create(client)
    link_id = created["id"]
    watermark = share_links.record_watermark(db_session, TEST_USER_ID)

    assert _link_row(db_session, link_id).open_count == 0

    await _open(client, created["token"])
    first = _link_row(db_session, link_id)
    assert first.open_count == 1
    assert first.first_opened_at is not None
    assert first.last_opened_at == first.first_opened_at
    assert first.first_open_record_at == watermark
    assert first.last_open_record_at == watermark

    # A refresh inside the debounce window is the same visit: not even the
    # last stamp moves.
    await _open(client, created["token"])
    again = _link_row(db_session, link_id)
    assert again.open_count == 1
    assert again.last_opened_at == first.last_opened_at

    # Past the window a real second visit counts, and the record grew in
    # between — exactly "came back after new data".
    db_session.query(ShareLink).filter(ShareLink.id == link_id).update(
        {
            ShareLink.last_opened_at: datetime.now(timezone.utc)
            - timedelta(seconds=share_links.SHARE_OPEN_DEBOUNCE_SECONDS + 60)
        },
        synchronize_session=False,
    )
    db_session.add(
        MedicalEntry(
            id="new-data",
            patient_id=TEST_USER_ID,
            type="doctor_visit",
            date=_at("2026-01-05"),
            title="New results",
        )
    )
    db_session.commit()

    await _open(client, created["token"])
    third = _link_row(db_session, link_id)
    assert third.open_count == 2
    assert third.first_opened_at == first.first_opened_at
    assert third.first_open_record_at == first.first_open_record_at
    assert third.last_open_record_at > third.first_open_record_at


async def test_public_read_marks_the_open_for_the_sender(share_api, db_session):
    """The counters the sender sees come from the recipient's GET, and the
    public payload still carries no counter or watermark of its own."""
    client, _principal = share_api
    created = await _create(client)
    body = (await _open(client, created["token"])).json()
    assert "open_count" not in body and "open_count" not in body["meta"]

    listed = (await client.get("/api/share/links")).json()["links"][0]
    assert listed["open_count"] == 1
    assert listed["last_opened_at"] is not None
    assert listed["first_opened_at"] == listed["last_opened_at"]


async def test_new_data_notice_lifecycle_and_read_only_read(share_api, db_session):
    """S9: false at creation, true after new data, false after the ack — and
    asking for the notice never acknowledges it."""
    client, _principal = share_api
    created = await _create(client)

    assert (await client.get("/api/share/notice")).json() == {
        "active_links": 1,
        "show": False,
    }

    db_session.add(
        MedicalEntry(
            id="notice-new",
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=_at("2026-02-01"),
            title="New panel",
        )
    )
    db_session.commit()
    assert (await client.get("/api/share/notice")).json() == {
        "active_links": 1,
        "show": True,
    }

    before = _link_row(db_session, created["id"]).notified_record_at
    second = (await client.get("/api/share/notice")).json()
    assert second == {"active_links": 1, "show": True}
    assert _link_row(db_session, created["id"]).notified_record_at == before

    acked = await client.post("/api/share/notice/ack")
    assert acked.json() == {"success": True, "acknowledged": 1}
    assert (await client.get("/api/share/notice")).json() == {
        "active_links": 1,
        "show": False,
    }
    assert (
        _link_row(db_session, created["id"]).notified_record_at
        == share_links.record_watermark(db_session, TEST_USER_ID)
    )

    # A revoked link is closed history: it neither shows a notice nor counts.
    await client.post(f"/api/share/links/{created['id']}/revoke")
    assert (await client.get("/api/share/notice")).json() == {
        "active_links": 0,
        "show": False,
    }


async def test_acknowledge_settles_expired_links_and_skips_revoked_ones(share_api, db_session):
    client, _principal = share_api
    expired = await _create(client)
    revoked = await _create(client)

    # The first link falls out of its window; the second is taken back. Both
    # were stamped at creation, so "settled by the ack" has to mean *moved*.
    db_session.query(ShareLink).filter(ShareLink.id == expired["id"]).update(
        {ShareLink.expires_at: datetime.now(timezone.utc) - timedelta(days=1)},
        synchronize_session=False,
    )
    db_session.commit()
    await client.post(f"/api/share/links/{revoked['id']}/revoke")
    revoked_stamp = _link_row(db_session, revoked["id"]).notified_record_at

    db_session.add(
        MedicalEntry(
            id="post-link-data",
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=_at("2026-05-01"),
            title="Data added after the links were made",
        )
    )
    db_session.commit()
    watermark = share_links.record_watermark(db_session, TEST_USER_ID)
    assert revoked_stamp != watermark

    assert (await client.post("/api/share/notice/ack")).json() == {
        "success": True,
        "acknowledged": 1,
    }
    db_session.expire_all()
    assert _link_row(db_session, expired["id"]).notified_record_at == watermark
    assert _link_row(db_session, revoked["id"]).notified_record_at == revoked_stamp


async def test_link_list_reports_state_scope_and_new_data(share_api, db_session):
    """The exact contract the settings card is built against."""
    client, _principal = share_api
    ranged = await _create(
        client, scope={"kind": "range", "from": SCOPE_FROM, "to": None}
    )

    summaries = (await client.get("/api/share/links")).json()["links"]
    assert len(summaries) == 1
    summary = summaries[0]
    assert set(summary) == {
        "id",
        "created_at",
        "expires_at",
        "revoked_at",
        "first_opened_at",
        "open_count",
        "last_opened_at",
        "is_anonymous",
        "scope",
        "include_header",
        "state",
        "has_new_data",
    }
    assert summary["state"] == "active"
    assert summary["has_new_data"] is False
    assert summary["open_count"] == 0
    assert summary["last_opened_at"] is None
    assert summary["scope"] == {"kind": "range", "from": SCOPE_FROM, "to": None}

    # The all-record case reports both keys with real nulls.
    whole = await _create(client)
    all_record = next(
        link
        for link in (await client.get("/api/share/links")).json()["links"]
        if link["id"] == whole["id"]
    )
    assert all_record["scope"] == {"kind": "all", "from": None, "to": None}

    await _open(client, ranged["token"])
    opened = next(
        link
        for link in (await client.get("/api/share/links")).json()["links"]
        if link["id"] == ranged["id"]
    )
    assert opened["open_count"] == 1
    assert opened["last_opened_at"] is not None

    # New data on the record flips has_new_data for both links; acknowledging
    # settles them together.
    db_session.add(
        MedicalEntry(
            id="list-new-data",
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=_at("2026-03-01"),
            title="Newer panel",
        )
    )
    db_session.commit()
    assert all(
        link["has_new_data"] for link in (await client.get("/api/share/links")).json()["links"]
    )
    await client.post("/api/share/notice/ack")
    assert not any(
        link["has_new_data"] for link in (await client.get("/api/share/links")).json()["links"]
    )

    # Revoked wins over "new data" and over expiry.
    db_session.add(
        MedicalEntry(
            id="list-newer-data",
            patient_id=TEST_USER_ID,
            type="blood_test",
            date=_at("2026-04-01"),
            title="Newest panel",
        )
    )
    db_session.commit()
    await client.post(f"/api/share/links/{ranged['id']}/revoke")
    db_session.add(
        ShareLink(
            id="expired-row",
            token_hash=share_links.hash_token("hp_expired-state-token"),
            owner_id=TEST_USER_ID,
            is_anonymous=False,
            include_header=True,
            include_notes=False,
            created_at=datetime.now(timezone.utc) - timedelta(days=30),
            expires_at=datetime.now(timezone.utc) - timedelta(days=2),
        )
    )
    db_session.commit()

    listed = {
        link["id"]: link for link in (await client.get("/api/share/links")).json()["links"]
    }
    assert listed[ranged["id"]]["state"] == "revoked"
    assert listed[ranged["id"]]["revoked_at"] is not None
    assert listed[ranged["id"]]["has_new_data"] is False
    assert listed["expired-row"]["state"] == "expired"
    assert listed["expired-row"]["has_new_data"] is True

    # ... and a revoked row that is also expired is still "revoked".
    db_session.query(ShareLink).filter(ShareLink.id == "expired-row").update(
        {ShareLink.revoked_at: datetime.now(timezone.utc)}, synchronize_session=False
    )
    db_session.commit()
    listed = {
        link["id"]: link for link in (await client.get("/api/share/links")).json()["links"]
    }
    assert listed["expired-row"]["state"] == "revoked"


async def test_include_notes_is_gone_from_the_wire(share_api, db_session):
    """S3: the toggle left the API surface; the column stays, unread."""
    client, _principal = share_api
    created = await _create(client, scope={"kind": "all"}, include_header=False)
    assert "include_notes" not in created
    assert created["include_header"] is False

    summary = (await client.get("/api/share/links")).json()["links"][0]
    assert "include_notes" not in summary

    body = (await _open(client, created["token"])).json()
    assert "include_notes" not in body and "include_notes" not in body["meta"]

    # The column survives on the row (this repo only ever adds columns).
    assert _link_row(db_session, created["id"]).include_notes is False


async def test_funnel_rows_are_written_once_per_sender_action(share_api, db_session):
    """S1: sender actions only, one row each, no recipient identity anywhere."""
    client, principal = share_api

    assert {c.name for c in ShareFunnelEvent.__table__.columns} == {
        "id", "event", "is_anonymous", "created_at",
    }
    assert _funnel(db_session) == []

    first = await _create(client)
    second = await _create(client)
    assert [row.event for row in _funnel(db_session)] == ["link_created", "link_created"]
    assert all(row.is_anonymous is False for row in _funnel(db_session))
    # (both links are open here; `first` is the one closed below)
    assert (await _open(client, second["token"])).status_code == 200

    await client.post(f"/api/share/links/{first['id']}/revoke")
    # Idempotent: the second revoke closes nothing, so it writes nothing.
    await client.post(f"/api/share/links/{first['id']}/revoke")
    assert [row.event for row in _funnel(db_session)] == [
        "link_created", "link_created", "link_revoked",
    ]

    assert (await client.post("/api/share/links/revoke-all")).json()["revoked"] == 1
    assert [row.event for row in _funnel(db_session)] == [
        "link_created", "link_created", "link_revoked", "link_revoked",
    ]
    assert (await client.post("/api/share/links/revoke-all")).json()["revoked"] == 0
    assert len(_funnel(db_session)) == 4

    principal.update(owner_id=TEST_ANON_ID, is_anonymous=True)
    await _create(client)
    assert _funnel(db_session)[-1].is_anonymous is True


async def test_revoke_link_is_callable_the_way_the_ops_script_calls_it(share_api, db_session):
    """S7: the ops script finds the row by token hash; the service call it
    makes from there must work, be idempotent and stay owner-checked."""
    client, _principal = share_api
    created = await _create(client)

    row = (
        db_session.query(ShareLink)
        .filter(ShareLink.token_hash == share_links.hash_token(created["token"]))
        .one()
    )
    assert share_links.revoke_link(db_session, row.owner_id, row.id) is True
    assert (await _open(client, created["token"])).status_code == 404

    # A second pass (the script run twice) revokes nothing and writes no row.
    assert share_links.revoke_link(db_session, row.owner_id, row.id) is True
    assert [event.event for event in _funnel(db_session)] == [
        "link_created", "link_revoked",
    ]

    # Another principal's id cannot close it.
    other = await _create(client)
    other_row = (
        db_session.query(ShareLink)
        .filter(ShareLink.token_hash == share_links.hash_token(other["token"]))
        .one()
    )
    assert share_links.revoke_link(db_session, TEST_ANON_ID, other_row.id) is False
    assert (await _open(client, other["token"])).status_code == 200
