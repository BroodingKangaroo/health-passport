"""Stage 4 of the shareable link: passcode protection and type exclusions.

Two things are being protected here, and both are the kind of mistake that
looks fine in review and leaks in production:

1. A passcode-protected link must be indistinguishable from a dead one to
   anyone without the code, and the code must not be brute-forceable.
2. An entry-type exclusion must reach EVERY section. The Stage 2 review found
   exactly this class of bug (a scope filter that reached four builders out of
   five), so each section is asserted by name.

Everything runs offline against in-memory SQLite.
"""

import hashlib
import hmac
import logging as _logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
import pytest_asyncio
from fastapi import FastAPI, Request, Response
from httpx import ASGITransport, AsyncClient

from app import auth
from app.api.auth import get_current_user_or_anon
from app.api.share import (
    SHARE_GRANT_HEADER,
    SHARE_TOKEN_HEADER,
    reset_public_throttle,
    reset_unlock_throttle,
)
from app.api.share import router as share_router
from app.auth import get_password_hash, verify_password
from app.db.models import (
    BiomarkerDefinition,
    BiomarkerReading,
    InstrumentalData,
    MedicalEntry,
    Patient,
    ShareFunnelEvent,
    ShareLink,
    VisitData,
)
from app.db.session import get_db
from app.i18n import MESSAGES, LocaleMiddleware
from app.services import share_links
from tests.seed_data import TEST_ANON_ID, TEST_USER_ID

DEAD_LINK_EN = MESSAGES["share.link_unavailable"]["en"]
UNLOCK_FAILED_EN = MESSAGES["share.unlock_failed"]["en"]
PASSCODE = "swordfish"

_ID_SUFFIX = {
    "blood_test": "blood",
    "doctor_visit": "visit",
    "instrumental_test": "instrumental",
    "procedure": "procedure",
}


@pytest_asyncio.fixture
async def share_api(db_session):
    """The share router with a swappable principal, the same shape as the
    Stage 1 harness so both files exercise the same code path."""
    app = FastAPI()
    app.add_middleware(LocaleMiddleware)
    app.include_router(share_router)

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
    reset_unlock_throttle()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, principal


async def _create(client, **body) -> dict:
    resp = await client.post("/api/share/links", json=body or None)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _unlock(client, token: str, passcode: str):
    return await client.post(
        "/api/share/unlock", json={"token": token, "passcode": passcode}
    )


async def _open(client, token: str, grant: Optional[str] = None):
    headers = {SHARE_TOKEN_HEADER: token}
    if grant:
        headers[SHARE_GRANT_HEADER] = grant
    return await client.get("/api/share/record", headers=headers)


def _expired_grant(link_id: str) -> str:
    """An already-expired grant signed with the REAL secret, so the test fails
    on the expiry rather than on a signature that never validated anyway."""
    expires_at = int(datetime.now(timezone.utc).timestamp()) - 10
    message = "|".join(("share-grant-v1", link_id, str(expires_at), "-"))
    signature = hmac.new(
        auth.SECRET_KEY.encode(), message.encode(), hashlib.sha256
    ).hexdigest()
    return f"{expires_at}.{signature}"


# --------------------------------------------------------------------------
# 4.1 passcode: storage and validation
# --------------------------------------------------------------------------


async def test_passcode_is_hashed_and_never_echoed(share_api, db_session):
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)

    assert created["requires_passcode"] is True
    assert PASSCODE not in str(created)

    row = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).one()
    assert row.passcode_hash
    assert row.passcode_hash != PASSCODE
    assert verify_password(PASSCODE, row.passcode_hash)
    stored = {c.name: getattr(row, c.name) for c in row.__table__.columns}
    assert PASSCODE not in str(stored)

    listed = (await client.get("/api/share/links")).json()["links"][0]
    assert listed["requires_passcode"] is True
    assert PASSCODE not in str(listed)


async def test_short_passcode_is_refused_with_a_localized_400(share_api):
    client, _ = share_api
    english = await client.post(
        "/api/share/links", json={"passcode": "abc"}, headers={"Accept-Language": "en"}
    )
    russian = await client.post(
        "/api/share/links", json={"passcode": "abc"}, headers={"Accept-Language": "ru"}
    )
    assert english.status_code == 400
    assert english.json()["detail"] == MESSAGES["share.passcode_too_short"]["en"].format(
        min=6
    )
    assert russian.json()["detail"] == MESSAGES["share.passcode_too_short"]["ru"].format(
        min=6
    )


async def test_link_without_a_passcode_is_unprotected(share_api):
    client, _ = share_api
    created = await _create(client)
    assert created["requires_passcode"] is False
    assert (await _open(client, created["token"])).status_code == 200


async def test_passcode_of_exactly_the_minimum_is_accepted(share_api):
    client, _ = share_api
    created = await _create(client, passcode="abcdef")
    assert created["requires_passcode"] is True


# --------------------------------------------------------------------------
# 4.1 passcode: the read gate
# --------------------------------------------------------------------------


async def test_protected_link_refuses_a_read_without_a_grant(share_api):
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)
    refused = await _open(client, created["token"])
    assert refused.status_code == 404
    assert refused.json()["detail"] == DEAD_LINK_EN


async def test_protected_link_is_indistinguishable_from_a_dead_one(share_api):
    """The core privacy property: no probe can tell a live protected link from
    a token that was never issued."""
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)

    responses = [
        await _open(client, created["token"]),
        await _open(client, "hp_never-issued"),
        await client.get("/api/share/record"),
    ]
    assert {r.status_code for r in responses} == {404}
    assert len({r.text for r in responses}) == 1


async def test_a_grant_for_one_link_does_not_open_another(share_api):
    client, _ = share_api
    first = await _create(client, passcode=PASSCODE)
    second = await _create(client, passcode="different-code")
    grant = (await _unlock(client, first["token"], PASSCODE)).json()["grant"]

    assert (await _open(client, first["token"], grant)).status_code == 200
    assert (await _open(client, second["token"], grant)).status_code == 404


async def test_a_garbage_grant_is_refused(share_api):
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)
    for bad in ("nonsense", "12345.deadbeef", "abc.def"):
        assert (await _open(client, created["token"], bad)).status_code == 404


# --------------------------------------------------------------------------
# 4.1 passcode: unlock
# --------------------------------------------------------------------------


async def test_unlock_returns_a_working_grant(share_api):
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)
    unlocked = await _unlock(client, created["token"], PASSCODE)
    assert unlocked.status_code == 200
    body = unlocked.json()
    assert body["grant"]
    assert PASSCODE not in str(body)
    assert datetime.fromisoformat(body["expires_at"]) > datetime.now(timezone.utc)

    opened = await _open(client, created["token"], body["grant"])
    assert opened.status_code == 200
    assert opened.json()["header"]["name"] == "Test User"
    assert unlocked.headers["cache-control"] == "no-store"


async def test_unlock_failures_are_uniform(share_api):
    """A wrong code, an unprotected link and an unknown token answer
    identically, so the endpoint cannot confirm that a token exists."""
    client, _ = share_api
    protected = await _create(client, passcode=PASSCODE)
    unprotected = await _create(client)

    responses = [
        await _unlock(client, protected["token"], "not-the-code"),
        await _unlock(client, unprotected["token"], PASSCODE),
        await _unlock(client, "hp_never-issued", PASSCODE),
    ]
    assert {r.status_code for r in responses} == {400}
    assert len({r.text for r in responses}) == 1
    assert responses[0].json()["detail"] == UNLOCK_FAILED_EN


async def test_unlock_is_localized(share_api):
    client, _ = share_api
    protected = await _create(client, passcode=PASSCODE)
    russian = await client.post(
        "/api/share/unlock",
        json={"token": protected["token"], "passcode": "wrong"},
        headers={"Accept-Language": "ru"},
    )
    assert russian.json()["detail"] == MESSAGES["share.unlock_failed"]["ru"]


async def test_unlock_throttles_per_link(share_api):
    """Ten attempts per window, counting failures, then a 429 shaped by the
    presented token's hash rather than by whether the link is real."""
    client, _ = share_api
    protected = await _create(client, passcode=PASSCODE)

    for _ in range(10):
        assert (await _unlock(client, protected["token"], "wrong")).status_code == 400

    throttled = await _unlock(client, protected["token"], "wrong")
    assert throttled.status_code == 429
    assert throttled.json()["detail"] == MESSAGES["share.too_many_requests"]["en"]

    # The CORRECT code is refused while the window is full: the throttle guards
    # the passcode space, not merely wrong guesses.
    assert (await _unlock(client, protected["token"], PASSCODE)).status_code == 429

    # A different token has its own budget - including a garbage one, which is
    # what stops the 429 from revealing that the first token is real.
    assert (await _unlock(client, "hp_some-other-token", "wrong")).status_code == 400


# --------------------------------------------------------------------------
# 4.1 passcode: the grant is a bearer credential with a shelf life
# --------------------------------------------------------------------------


async def test_expired_grant_is_refused(share_api):
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)
    grant = (await _unlock(client, created["token"], PASSCODE)).json()["grant"]
    assert (await _open(client, created["token"], grant)).status_code == 200

    stale = _expired_grant(created["id"])
    assert (await _open(client, created["token"], stale)).status_code == 404


async def test_changing_the_passcode_invalidates_outstanding_grants(
    share_api, db_session
):
    """The fingerprint is what makes a passcode change a revocation of every
    grant already handed out, with nothing stored to invalidate."""
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)
    grant = (await _unlock(client, created["token"], PASSCODE)).json()["grant"]
    assert (await _open(client, created["token"], grant)).status_code == 200

    row = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).one()
    row.passcode_hash = get_password_hash("a-brand-new-code")
    db_session.commit()

    assert (await _open(client, created["token"], grant)).status_code == 404
    renewed = await _unlock(client, created["token"], "a-brand-new-code")
    assert (
        await _open(client, created["token"], renewed.json()["grant"])
    ).status_code == 200


async def test_grant_never_outlives_the_link(share_api):
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)
    grant = (await _unlock(client, created["token"], PASSCODE)).json()["grant"]
    assert (await _open(client, created["token"], grant)).status_code == 200

    await client.post(f"/api/share/links/{created['id']}/revoke")
    assert (await _open(client, created["token"], grant)).status_code == 404


async def test_expired_link_refuses_the_grant(share_api, db_session):
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)
    grant = (await _unlock(client, created["token"], PASSCODE)).json()["grant"]

    row = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).one()
    row.expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db_session.commit()

    assert (await _open(client, created["token"], grant)).status_code == 404


async def test_unlock_does_not_count_as_an_open(share_api, db_session):
    """Only a successful READ is an open: unlocking must not inflate the
    sender's counter."""
    client, _ = share_api
    created = await _create(client, passcode=PASSCODE)
    await _unlock(client, created["token"], "wrong")
    await _unlock(client, created["token"], PASSCODE)

    row = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).one()
    assert (row.open_count or 0) == 0


# --------------------------------------------------------------------------
# 4.2 entry-type exclusions
# --------------------------------------------------------------------------


def _seed_every_type(db_session, patient_id: str = TEST_USER_ID) -> None:
    """One entry of each type, with the payload row that makes it visible in
    its own section."""
    when = datetime(2026, 5, 1, tzinfo=timezone.utc)
    db_session.add_all(
        [
            MedicalEntry(
                id="s4-blood",
                patient_id=patient_id,
                type="blood_test",
                date=when,
                title="Stage 4 blood",
            ),
            MedicalEntry(
                id="s4-visit",
                patient_id=patient_id,
                type="doctor_visit",
                date=when,
                title="Stage 4 visit",
            ),
            MedicalEntry(
                id="s4-instrumental",
                patient_id=patient_id,
                type="instrumental_test",
                date=when,
                title="Stage 4 MRI",
            ),
            MedicalEntry(
                id="s4-procedure",
                patient_id=patient_id,
                type="procedure",
                date=when,
                title="Stage 4 procedure",
            ),
        ]
    )
    db_session.add(
        VisitData(
            entry_id="s4-visit",
            specialty="Cardiology",
            provider="Dr. Stage",
            date=when,
            clinic="Stage Clinic",
            verdict={"original": "Fine", "translated_en": "Fine"},
            notes=[],
            prescriptions=[],
            recommendations=[],
        )
    )
    db_session.add(
        InstrumentalData(
            entry_id="s4-instrumental",
            modality="MRI",
            findings="Stage 4 findings",
            conclusion="Stage 4 conclusion",
        )
    )
    db_session.add(
        BiomarkerDefinition(
            id="s4-def",
            user_id=patient_id,
            names={"en": "Stage 4 marker"},
            unit="mg/dL",
            category="Stage 4",
            reference={"kind": "interval", "low": 0, "high": 10},
        )
    )
    db_session.add(
        BiomarkerReading(
            biomarker_id="s4-def",
            entry_id="s4-blood",
            value=42,
            reference={"kind": "interval", "low": 0, "high": 10},
            status="high",
            needs_review=False,
            merged=False,
        )
    )
    db_session.commit()


def _section_ids(payload: dict, key: str) -> set[str]:
    """The entry ids a section holds, whichever shape it uses: `events` is a
    list, the visit/instrumental maps are keyed by entry id."""
    value = payload[key]
    if isinstance(value, list):
        return {item["id"] for item in value}
    return set(value.keys())


@pytest.mark.parametrize("excluded", sorted(_ID_SUFFIX))
async def test_an_exclusion_narrows_every_section(share_api, db_session, excluded):
    """The Stage 2 lesson, asserted section by section: a filter that reaches
    four builders out of five leaks exactly what was switched off."""
    client, _ = share_api
    _seed_every_type(db_session)
    created = await _create(client, scope={"kind": "all", "exclude": [excluded]})

    body = (await _open(client, created["token"])).json()
    events = _section_ids(body, "events")

    # The excluded entry is gone from the timeline...
    assert f"s4-{_ID_SUFFIX[excluded]}" not in events
    # ...and its own section is empty...
    if excluded == "doctor_visit":
        assert body["visits"] == {}
    elif excluded == "instrumental_test":
        assert body["instrumental"] == {}
    elif excluded == "blood_test":
        assert body["biomarkers"] == []
    # ...while the lab result survives an exclusion aimed at anything else.
    if excluded != "blood_test":
        assert any(b["definition"]["id"] == "s4-def" for b in body["biomarkers"])


async def test_excluding_a_non_lab_type_keeps_the_other_sections(share_api, db_session):
    """Coverage for the sections the parametrized test above cannot assert
    without a per-type table: drop one type, and the OTHER payload rows are
    still exactly where they were."""
    client, _ = share_api
    _seed_every_type(db_session)
    created = await _create(client, scope={"kind": "all", "exclude": ["procedure"]})

    body = (await _open(client, created["token"])).json()
    events = _section_ids(body, "events")
    assert "s4-procedure" not in events
    assert "s4-visit" in events
    assert "s4-instrumental" in events
    assert "s4-blood" in events
    assert "s4-visit" in body["visits"]
    assert "s4-instrumental" in body["instrumental"]


async def test_excluding_blood_tests_empties_the_results_table(share_api, db_session):
    """Excluding blood tests must empty the biomarker lists AND the table, and
    the dialog warns about it before the sender finds out on the recipient's
    screen."""
    client, _ = share_api
    _seed_every_type(db_session)
    created = await _create(client, scope={"kind": "all", "exclude": ["blood_test"]})

    body = (await _open(client, created["token"])).json()
    assert body["biomarkers"] == []
    flowsheet = (
        await client.get(
            "/api/share/flowsheet", headers={SHARE_TOKEN_HEADER: created["token"]}
        )
    ).json()
    assert flowsheet["matrix"] == []
    assert flowsheet["biomarkers"] == []
    assert flowsheet["dates"] == []
    # The non-lab history survives.
    assert "s4-visit" in _section_ids(body, "events")


async def test_exclusions_and_a_range_compose(share_api, db_session):
    """`exclude` rides both scope kinds: "the last year, but not the imaging"
    is one scope, not two features."""
    client, _ = share_api
    _seed_every_type(db_session)
    created = await _create(
        client,
        scope={
            "kind": "range",
            "from": "2026-01-01",
            "to": "2026-12-31",
            "exclude": ["instrumental_test", "procedure"],
        },
    )
    body = (await _open(client, created["token"])).json()
    events = _section_ids(body, "events")
    assert "s4-instrumental" not in events
    assert "s4-procedure" not in events
    assert "s4-visit" in events
    assert body["instrumental"] == {}
    assert body["meta"]["scope"] == {
        "kind": "range",
        "from": "2026-01-01",
        "to": "2026-12-31",
        "exclude": ["instrumental_test", "procedure"],
    }


async def test_scope_reports_the_exclusions_and_normalises_them(share_api):
    client, _ = share_api
    created = await _create(
        client,
        scope={"kind": "all", "exclude": ["procedure", "blood_test", "procedure"]},
    )
    # Deduplicated and in canonical order, not in the order the client sent.
    assert created["scope"] == {
        "kind": "all",
        "exclude": ["blood_test", "procedure"],
    }
    body = (await _open(client, created["token"])).json()
    assert body["meta"]["scope"] == created["scope"]


async def test_an_empty_exclusion_list_is_the_whole_record(share_api):
    client, _ = share_api
    created = await _create(client, scope={"kind": "all", "exclude": []})
    assert created["scope"] == {"kind": "all"}


async def test_unknown_entry_types_are_refused_with_a_localized_400(share_api):
    client, _ = share_api
    for bad in (["surgery"], ["blood_test", "surgery"], [1], "blood_test"):
        resp = await client.post(
            "/api/share/links",
            json={"scope": {"kind": "all", "exclude": bad}},
            headers={"Accept-Language": "en"},
        )
        assert resp.status_code == 400, bad
        assert resp.json()["detail"] == MESSAGES["share.exclude_invalid"]["en"]

    russian = await client.post(
        "/api/share/links",
        json={"scope": {"kind": "all", "exclude": ["nope"]}},
        headers={"Accept-Language": "ru"},
    )
    assert russian.json()["detail"] == MESSAGES["share.exclude_invalid"]["ru"]


async def test_exclusions_cannot_be_widened_by_the_recipient(share_api, db_session):
    """The public read takes no scope override: a recipient cannot re-enable an
    excluded type by asking (the rule the Stage 2 date range follows too)."""
    client, _ = share_api
    _seed_every_type(db_session)
    created = await _create(client, scope={"kind": "all", "exclude": ["doctor_visit"]})

    body = (
        await client.get(
            "/api/share/record",
            headers={SHARE_TOKEN_HEADER: created["token"]},
            params={"exclude": "", "scope": '{"kind":"all"}'},
        )
    ).json()
    assert "s4-visit" not in _section_ids(body, "events")
    assert body["visits"] == {}


async def test_an_unexcluded_link_is_unchanged(share_api, db_session):
    """Regression guard: Stage 4 must not narrow anything for a link that opted
    into nothing."""
    client, _ = share_api
    _seed_every_type(db_session)
    created = await _create(client)
    body = (await _open(client, created["token"])).json()

    events = _section_ids(body, "events")
    assert {"s4-blood", "s4-visit", "s4-instrumental", "s4-procedure"} <= events
    assert "s4-visit" in body["visits"]
    assert "s4-instrumental" in body["instrumental"]
    assert any(b["definition"]["id"] == "s4-def" for b in body["biomarkers"])


async def test_exclusions_are_owner_scoped(share_api, db_session):
    client, principal = share_api
    _seed_every_type(db_session, patient_id=TEST_ANON_ID)

    principal.update(owner_id=TEST_ANON_ID, is_anonymous=True)
    anon_link = await _create(client)
    anonymised = (await _open(client, anon_link["token"])).json()
    assert "s4-procedure" in _section_ids(anonymised, "events")

    principal.update(owner_id=TEST_USER_ID, is_anonymous=False)
    user_link = await _create(client, scope={"kind": "all", "exclude": ["procedure"]})
    user_body = (await _open(client, user_link["token"])).json()
    assert "s4-procedure" not in _section_ids(user_body, "events")


async def test_unparseable_stored_scope_fails_open_and_logs(
    share_api, db_session, caplog
):
    """A row edited outside the app must not turn a recipient's page into a
    500 - the documented Stage 2 behaviour, extended to the exclusions."""
    client, _ = share_api
    created = await _create(client)
    row = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).one()
    row.scope = {"kind": "all", "exclude": ["not-a-real-type"]}
    db_session.commit()

    with caplog.at_level(_logging.ERROR):
        resp = await _open(client, created["token"])
    assert resp.status_code == 200
    assert any("exclude" in record.getMessage() for record in caplog.records)


# --------------------------------------------------------------------------
# 4.3 the metrics reader (ops tooling)
# --------------------------------------------------------------------------


def test_metrics_report_counts_what_the_funnel_holds(db_session):
    """The reader answers the roadmap's gate: links created, opened, revoked,
    and the loop — from rows, with no recipient identity to be had."""
    from scripts.share_metrics import collect

    _seed_every_type(db_session)
    now = datetime.now(timezone.utc)
    db_session.add_all(
        [
            ShareLink(
                id="m-open",
                token_hash="hash-open",
                owner_id=TEST_USER_ID,
                is_anonymous=False,
                include_header=True,
                include_notes=False,
                open_count=3,
                created_at=now,
                expires_at=now + timedelta(days=7),
                passcode_hash="$2b$12$abcdefghijklmnopqrstuv",
            ),
            ShareLink(
                id="m-never",
                token_hash="hash-never",
                owner_id=TEST_USER_ID,
                is_anonymous=False,
                include_header=True,
                include_notes=False,
                open_count=0,
                created_at=now,
                expires_at=now + timedelta(days=7),
            ),
        ]
    )
    share_links._funnel(db_session, share_links.FUNNEL_LINK_CREATED, False)
    share_links._funnel(db_session, share_links.FUNNEL_LINK_REVOKED, True)
    share_links._funnel(db_session, share_links.FUNNEL_CTA_CLICKED, None)
    db_session.commit()

    report = collect(db_session)
    assert report["links"]["total"] == 2
    assert report["links"]["opened_at_least_once"] == 1
    assert report["links"]["repeat_opens"] == 1
    assert report["links"]["protected"] == 1
    assert report["links"]["total_opens"] == 3
    assert report["funnel"]["link_created"] == 1
    assert report["funnel"]["link_created_registered"] == 1
    assert report["funnel"]["link_revoked"] == 1
    assert report["funnel"]["cta_clicked"] == 1
    assert report["rates"]["open_rate"] == 0.5
    # A rate with no denominator is None, not 0.0: "nobody used it" and
    # "everybody ignored it" are different facts.
    assert report["rates"]["revoke_rate"] == 1.0


def test_metrics_report_says_n_a_rather_than_zero_with_no_links(db_session):
    from scripts.share_metrics import collect

    report = collect(db_session)
    assert report["links"]["total"] == 0
    assert report["rates"]["open_rate"] is None
    assert report["rates"]["revoke_rate"] is None


def test_metrics_report_never_carries_recipient_identity(db_session):
    """The whole point of the write-only funnel: the reader cannot leak what was
    never stored. This asserts the report's keys, so a future field has to be
    added deliberately."""
    from scripts.share_metrics import collect

    report = collect(db_session)
    blob = str(report).lower()
    for forbidden in ("ip", "user_agent", "agent", "email", "token", "owner"):
        assert forbidden not in blob, forbidden


# --------------------------------------------------------------------------
# Stage 4 review fixes
# --------------------------------------------------------------------------


async def test_a_locked_write_never_fails_the_read(share_api, db_session, monkeypatch):
    """F1: the open counter is BEST-EFFORT.

    The real failure was SQLite refusing to upgrade the request's read
    snapshot when another writer moved the database on (``database is
    locked``), which turned concurrent public reads into 500s. Driven here at
    the service boundary so the test is deterministic: the counting statement
    is made to raise the same OperationalError both times, and the read path
    must still return the record.
    """
    import sqlite3

    from sqlalchemy.exc import OperationalError

    from app.services import share_links as sl

    def always_locked(*_args, **_kwargs):
        raise OperationalError("UPDATE share_links", {}, sqlite3.OperationalError("database is locked"))

    monkeypatch.setattr(sl, "_mark_opened_once", always_locked)

    client, _ = share_api
    created = await _create(client)
    resp = await _open(client, created["token"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["events"] is not None
    # Nothing was counted, and that is the accepted trade.
    row = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).one()
    assert (row.open_count or 0) == 0


def test_the_open_counter_fails_FAST_and_does_not_retry(db_session, monkeypatch):
    """F1: exactly ONE attempt, then give up.

    A retry was measured to make contention worse, not better: the fresh
    transaction no longer conflicts instantly, so it waits out ``busy_timeout``
    instead, and these reads are blocking DB work inside a single event loop —
    30 simultaneous reads were still pending at 60 s while the retry existed.
    So the contract is fail-fast, asserted here by counting the attempts.
    """
    from sqlalchemy.exc import OperationalError

    from app.services import share_links as sl

    calls: list[int] = []

    def locked(db, link_id):
        calls.append(1)
        raise OperationalError("UPDATE share_links", {}, Exception("database is locked"))

    monkeypatch.setattr(sl, "_mark_opened_once", locked)
    assert sl.mark_opened(db_session, "some-link") is False
    assert len(calls) == 1, "a retry would double the blocking wait"


def test_the_debounce_window_skips_the_write_entirely(db_session):
    """F1: a second load inside the debounce window must not take the write
    lock at all — that is what keeps a burst of refreshes from contending."""
    from app.services import share_links as sl

    now = datetime.now(timezone.utc)
    db_session.add(
        ShareLink(
            id="debounced",
            token_hash="hash-debounced",
            owner_id=TEST_USER_ID,
            is_anonymous=False,
            include_header=True,
            include_notes=False,
            open_count=1,
            last_opened_at=now,
            created_at=now,
            expires_at=now + timedelta(days=7),
        )
    )
    db_session.commit()

    assert sl.mark_opened(db_session, "debounced") is False
    db_session.expire_all()
    row = db_session.query(ShareLink).filter(ShareLink.id == "debounced").one()
    assert row.open_count == 1  # untouched, not merely rejected by the WHERE


def test_a_write_that_cannot_get_the_lock_does_not_fail_the_read(tmp_path):
    """F1, the real failure, reproduced deterministically.

    One connection holds SQLite's write lock; the reader's counting UPDATE
    therefore cannot be written and raises ``database is locked``. The raw
    statement must fail — that is the bug — and ``mark_opened`` must swallow it
    and return, so the read that triggered it still serves the record.

    ``timeout=0.05`` keeps the busy wait at 50 ms instead of the app's 10 s, so
    the test is fast and still deterministic: the lock is held for the whole
    call, so no amount of waiting could succeed.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.exc import OperationalError
    from sqlalchemy.orm import sessionmaker

    from app.db.models import Base
    from app.services import share_links as sl

    engine = create_engine(
        f"sqlite:///{tmp_path / 'locked.db'}",
        connect_args={"check_same_thread": False, "timeout": 0.05},
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)

    now = datetime.now(timezone.utc)
    setup = Session()
    setup.add(
        ShareLink(
            id="locked",
            token_hash="hash-locked",
            owner_id=TEST_USER_ID,
            is_anonymous=False,
            include_header=True,
            include_notes=False,
            created_at=now,
            expires_at=now + timedelta(days=7),
        )
    )
    setup.commit()
    setup.close()

    # A competing writer takes the write lock and keeps it.
    blocker = engine.raw_connection()
    blocker.execute("BEGIN IMMEDIATE")
    try:
        reader = Session()
        reader.query(ShareLink).filter(ShareLink.id == "locked").one()

        # The bug: this is what produced 13-of-20 500s.
        with pytest.raises(OperationalError) as caught:
            sl._mark_opened_once(reader, "locked")
        assert "locked" in str(caught.value).lower()
        reader.rollback()

        # The fix: the counter gives up, the read survives.
        assert sl.mark_opened(reader, "locked") is False
        reader.close()
    finally:
        blocker.rollback()
        blocker.close()
        engine.dispose()


def test_concurrent_opens_of_one_link_all_succeed(tmp_path):
    """F1, the reviewer's scenario in miniature: N threads reading one link.

    Each thread does what a request does — its own session, the SELECT, then
    the counting write — against one file-backed database. Every one of them
    must come back with an answer; none may raise. The counter itself is
    allowed to lose an increment, which is the contract the fix establishes.
    """
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker

    from app.db.models import Base
    from app.services import share_links as sl

    engine = create_engine(
        f"sqlite:///{tmp_path / 'concurrent.db'}",
        connect_args={"check_same_thread": False},
    )
    with engine.begin() as conn:
        conn.execute(text("PRAGMA journal_mode=WAL"))
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)

    now = datetime.now(timezone.utc)
    setup = Session()
    setup.add(
        ShareLink(
            id="busy",
            token_hash="hash-busy",
            owner_id=TEST_USER_ID,
            is_anonymous=False,
            include_header=True,
            include_notes=False,
            created_at=now,
            expires_at=now + timedelta(days=7),
        )
    )
    setup.commit()
    setup.close()

    errors: list[str] = []

    def read(_index: int) -> None:
        db = Session()
        try:
            link = db.query(ShareLink).filter(ShareLink.id == "busy").one()
            assert link is not None
            sl.mark_opened(db, "busy")
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
        finally:
            db.close()

    threads = [threading.Thread(target=read, args=(i,)) for i in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    engine.dispose()


async def test_every_refusal_carries_the_no_store_headers(share_api, db_session):
    """F2: the 404/429/400 path is no longer headerless.

    Stage 4 made this matter: the protected flow fetches the SAME url twice
    with different credentials (404 without a grant, 200 with one), so a
    shared cache keyed on the URL alone could pin the refusal.
    """
    client, _ = share_api
    protected = await _create(client, passcode=PASSCODE)

    refusals = [
        await client.get("/api/share/record"),  # no token
        await _open(client, "hp_unknown-token"),  # dead
        await _open(client, protected["token"]),  # protected, no grant
        await client.get("/api/share/flowsheet", headers={SHARE_TOKEN_HEADER: protected["token"]}),
        await _unlock(client, protected["token"], "wrong"),
    ]
    for resp in refusals:
        assert resp.status_code in (400, 404), resp.status_code
        assert resp.headers["cache-control"] == "no-store"
        assert resp.headers["x-robots-tag"] == "noindex, nofollow"
        vary = resp.headers["vary"]
        assert "X-Share-Token" in vary and "X-Share-Grant" in vary

    # And the success path keeps them, same shape.
    grant = (await _unlock(client, protected["token"], PASSCODE)).json()["grant"]
    ok = await _open(client, protected["token"], grant)
    assert ok.status_code == 200
    assert ok.headers["cache-control"] == "no-store"
    assert "X-Share-Grant" in ok.headers["vary"]


async def test_unlock_failure_is_uniform_for_missing_keys(share_api):
    """F4: omitting the passcode key (or sending null) is the SAME uniform 400
    as a wrong code — not a 422 that echoes the token back."""
    client, _ = share_api
    protected = await _create(client, passcode=PASSCODE)

    missing_key = await client.post("/api/share/unlock", json={"token": protected["token"]})
    null_key = await client.post(
        "/api/share/unlock", json={"token": protected["token"], "passcode": None}
    )
    wrong = await _unlock(client, protected["token"], "nope")

    assert missing_key.status_code == 400, missing_key.text
    assert null_key.status_code == 400, null_key.text
    assert missing_key.text == null_key.text == wrong.text
    assert protected["token"] not in missing_key.text

    # An entirely empty body is the same refusal rather than a 422.
    empty = await client.post("/api/share/unlock", json={})
    assert empty.status_code == 400


async def test_too_long_passcode_gets_its_own_sentence(share_api):
    """F6: a 73-byte code must not be told it needs 'at least 6 characters'."""
    client, _ = share_api
    too_long = "a" * 73
    resp = await client.post(
        "/api/share/links", json={"passcode": too_long}, headers={"Accept-Language": "en"}
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == MESSAGES["share.passcode_too_long"]["en"]
    assert resp.json()["detail"] != MESSAGES["share.passcode_too_short"]["en"].format(min=6)

    # The minimum-length sentence still applies to a short code.
    short = await client.post("/api/share/links", json={"passcode": "abc"})
    assert short.json()["detail"] == MESSAGES["share.passcode_too_short"]["en"].format(min=6)

    russian = await client.post(
        "/api/share/links", json={"passcode": too_long}, headers={"Accept-Language": "ru"}
    )
    assert russian.json()["detail"] == MESSAGES["share.passcode_too_long"]["ru"]


def test_metrics_splits_honour_the_window(db_session):
    """F5: `--since` used to apply to the totals but NOT to the
    anonymous/registered splits, so `--since 1` could print more registered
    creations than total creations. Every number now comes from the same
    windowed query."""
    from app.services import share_links as sl
    from scripts.share_metrics import collect

    now = datetime.now(timezone.utc)
    old = now - timedelta(days=10)
    rows = [
        # Inside the window.
        ShareFunnelEvent(event=sl.FUNNEL_LINK_CREATED, is_anonymous=False, created_at=now),
        ShareFunnelEvent(event=sl.FUNNEL_LINK_CREATED, is_anonymous=True, created_at=now),
        ShareFunnelEvent(event=sl.FUNNEL_LINK_REVOKED, is_anonymous=False, created_at=now),
        # Outside it.
        ShareFunnelEvent(event=sl.FUNNEL_LINK_CREATED, is_anonymous=False, created_at=old),
        ShareFunnelEvent(event=sl.FUNNEL_LINK_CREATED, is_anonymous=False, created_at=old),
        ShareFunnelEvent(event=sl.FUNNEL_LINK_CREATED, is_anonymous=False, created_at=old),
    ]
    db_session.add_all(rows)
    db_session.commit()

    everything = collect(db_session)
    assert everything["funnel"]["link_created"] == 5
    assert everything["funnel"]["link_created_registered"] == 4

    windowed = collect(db_session, since_days=1)
    funnel = windowed["funnel"]
    assert funnel["link_created"] == 2
    assert funnel["link_created_registered"] == 1
    assert funnel["link_created_anonymous"] == 1
    assert funnel["link_revoked"] == 1
    # The invariant the bug broke.
    assert (
        funnel["link_created_registered"] + funnel["link_created_anonymous"]
    ) <= funnel["link_created"]
