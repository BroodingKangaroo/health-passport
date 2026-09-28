"""The recipient's AI translation budget (shared-view plan ST4, §5).

A share link is a third principal class with no ``UsageLimit`` row, so the
allowance a stranger may spend is carried by the link itself. These tests are
the ones that fail if the budget is bypassable, if a recipient's run touches
the owner's quota, or if a run can write into the record's own dictionary.

The LLM is never called: ``app.api.share._get_client`` and
``_translate_names_to_lang`` are monkeypatched, so the assertions are about the
payload that WOULD be sent and about the budget arithmetic, not about a
translation.
"""

import asyncio
import json
import threading
import time
from typing import Optional
from unittest.mock import Mock

import pytest
import pytest_asyncio
from fastapi import FastAPI, Request, Response
from httpx import ASGITransport, AsyncClient

from app.api.ai import _category_cache_id, _clean_translation_name
from app.api.auth import get_current_user_or_anon
from app.api.share import SHARE_TOKEN_HEADER, reset_public_throttle
from app.api.share import router as share_router
from app.db.models import (
    BiomarkerDefinition,
    CategoryTranslationCache,
    Patient,
    ShareLink,
    UsageLimit,
)
from app.db.session import get_db
from app.i18n import MESSAGES, LocaleMiddleware
from app.services import share_links
from tests.seed_data import TEST_USER_ID

BUDGET = share_links.SHARE_TRANSLATION_BUDGET
LIMIT_EN = MESSAGES["share.translation_limit_reached"]["en"].format(budget=BUDGET)
LIMIT_RU = MESSAGES["share.translation_limit_reached"]["ru"].format(budget=BUDGET)


@pytest_asyncio.fixture
async def share_api(db_session):
    """The share router over the seeded record, with a swappable principal."""
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

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, principal


async def _create_link(client, body: Optional[dict] = None) -> dict:
    resp = await client.post("/api/share/links", json=body or {})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _translate(client, token: str, lang: str = "pl", headers: Optional[dict] = None):
    return await client.post(
        "/api/share/translate",
        json={"lang": lang},
        headers={SHARE_TOKEN_HEADER: token, **(headers or {})},
    )


def _fake_client(payload=None):
    client = Mock()
    client.chat.parse.return_value = Mock(
        choices=[Mock(message=Mock(content=json.dumps(payload or {"translations": []})))]
    )
    return client


def _install_llm(monkeypatch, *, fail: bool = False, seen: Optional[list] = None):
    """Patch the share module's LLM seams and return the ids it was asked for.

    Patching ``_translate_names_to_lang`` (rather than the Mistral client)
    means the assertion is on the exact batch the server chose to send — which
    is what "the payload is bounded to the record" actually claims.
    """

    def fake_translate(items, lang, client, glossary=None):
        if seen is not None:
            seen.append({"items": list(items), "lang": lang, "glossary": dict(glossary or {})})
        if fail:
            return {}
        return {
            def_id: f"{name}-{lang}"
            for def_id, name in items
            if not def_id.startswith("category:")
        } | {
            def_id: f"cat-{lang}"
            for def_id, _name in items
            if def_id.startswith("category:")
        }

    monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
    monkeypatch.setattr("app.api.share._get_client", lambda: _fake_client())
    monkeypatch.setattr("app.api.share._translate_names_to_lang", fake_translate)


def _defn(db_session, def_id: str) -> BiomarkerDefinition:
    return db_session.query(BiomarkerDefinition).filter(BiomarkerDefinition.id == def_id).first()


def _owner_quota(db_session) -> int:
    usage = db_session.query(UsageLimit).filter(UsageLimit.user_id == TEST_USER_ID).first()
    return usage.ai_extraction_count if usage else 0


class TestShareTranslationBudget:
    async def test_record_reports_the_budget_before_it_is_spent(self, share_api):
        client, _ = share_api
        created = await _create_link(client)
        record = await client.get(
            "/api/share/record", headers={SHARE_TOKEN_HEADER: created["token"]}
        )
        assert record.status_code == 200
        meta = record.json()["meta"]
        assert meta["translation_remaining"] == BUDGET
        assert meta["translation_budget"] == BUDGET

    async def test_three_runs_then_a_localized_block(
        self, share_api, db_session, monkeypatch
    ):
        client, _ = share_api
        created = await _create_link(client)
        _install_llm(monkeypatch)

        for expected_remaining in (BUDGET - 1, BUDGET - 2, BUDGET - 3):
            resp = await _translate(client, created["token"])
            assert resp.status_code == 200, resp.text
            assert resp.json()["remaining"] == expected_remaining

        blocked = await _translate(client, created["token"])
        assert blocked.status_code == 429
        assert blocked.json()["detail"] == LIMIT_EN
        # The refusal carries the same security headers as every public
        # response, including the 429 path.
        assert blocked.headers["cache-control"] == "no-store"
        assert _defn(db_session, "wbc") is not None  # request never wrote

    async def test_the_block_is_localized(self, share_api, monkeypatch):
        client, _ = share_api
        created = await _create_link(client)
        _install_llm(monkeypatch)
        for _ in range(BUDGET):
            await _translate(client, created["token"])
        blocked = await _translate(
            client, created["token"], headers={"Accept-Language": "ru-RU,ru;q=0.9"}
        )
        assert blocked.status_code == 429
        assert blocked.json()["detail"] == LIMIT_RU

    async def test_budget_is_per_link_not_per_record(
        self, share_api, db_session, monkeypatch
    ):
        client, _ = share_api
        first = await _create_link(client)
        second = await _create_link(client)
        _install_llm(monkeypatch)
        for _ in range(BUDGET):
            assert (await _translate(client, first["token"])).status_code == 200
        assert (await _translate(client, first["token"])).status_code == 429
        # A second link to the same record has its own allowance.
        assert (await _translate(client, second["token"])).status_code == 200

    async def test_a_revoked_link_cannot_spend(
        self, share_api, db_session, monkeypatch
    ):
        client, _ = share_api
        created = await _create_link(client)
        _install_llm(monkeypatch)
        await client.post(f"/api/share/links/{created['id']}/revoke")
        resp = await _translate(client, created["token"])
        assert resp.status_code == 404
        link = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).first()
        assert link.translate_runs_used == 0


class TestShareTranslationIsolation:
    async def test_owner_quota_is_untouched_and_no_usage_row_is_created(
        self, share_api, db_session, monkeypatch
    ):
        """The recipient's run is charged to the LINK. The owner's allowance is
        not decremented and no anonymous UsageLimit row appears."""
        client, _ = share_api
        created = await _create_link(client)
        before_owner = _owner_quota(db_session)
        before_rows = db_session.query(UsageLimit).count()
        _install_llm(monkeypatch)

        resp = await _translate(client, created["token"])
        assert resp.status_code == 200

        assert _owner_quota(db_session) == before_owner
        assert db_session.query(UsageLimit).count() == before_rows
        link = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).first()
        assert link.translate_runs_used == 1

    async def test_translation_is_never_persisted_into_the_record(
        self, share_api, db_session, monkeypatch
    ):
        client, _ = share_api
        created = await _create_link(client)
        _install_llm(monkeypatch)

        resp = await _translate(client, created["token"], lang="pl")
        assert resp.status_code == 200
        body = resp.json()
        assert body["translations"], "the record's own rows come back"
        # The response carries the fresh term...
        assert all(item["name"].endswith("-pl") for item in body["translations"])
        # ...and the owner's dictionary is untouched, so what the owner sees
        # next (and what the NEXT link reports) is unchanged.
        assert _defn(db_session, "wbc").names.get("pl") is None

    async def test_recipient_never_seeds_the_shared_category_cache(
        self, share_api, db_session, monkeypatch
    ):
        """An anonymous principal must not write headings every other user's
        render then trusts (ISSUES.md #33)."""
        client, _ = share_api
        created = await _create_link(client)
        _install_llm(monkeypatch)
        before = db_session.query(CategoryTranslationCache).count()

        resp = await _translate(client, created["token"], lang="pl")
        assert resp.status_code == 200
        assert resp.json()["categories"], "the record's headings are translated too"
        assert db_session.query(CategoryTranslationCache).count() == before

    async def test_payload_is_derived_from_the_record_not_the_client(
        self, share_api, monkeypatch
    ):
        """The body carries only the language: whatever the caller sends is
        ignored, and the batch is exactly the record's own definitions."""
        client, _ = share_api
        created = await _create_link(client)
        seen: list = []
        _install_llm(monkeypatch, seen=seen)

        # A caller smuggling a name list and a foreign concept id changes
        # nothing: the server never reads those fields.
        resp = await client.post(
            "/api/share/translate",
            json={
                "lang": "pl",
                "names": [{"id": "not-in-this-record", "name": "Foreign"}],
                "categories": ["Not In This Record"],
            },
            headers={SHARE_TOKEN_HEADER: created["token"]},
        )
        assert resp.status_code == 200
        sent_ids = {
            def_id
            for call in seen
            for def_id, _name in call["items"]
            if not def_id.startswith("category:")
        }
        record = await client.get(
            "/api/share/record", headers={SHARE_TOKEN_HEADER: created["token"]}
        )
        record_ids = {b["definition"]["id"] for b in record.json()["biomarkers"]}
        assert sent_ids
        assert sent_ids <= record_ids
        assert "not-in-this-record" not in sent_ids

    async def test_a_narrowed_link_only_translates_its_own_window(
        self, share_api, monkeypatch
    ):
        client, _ = share_api
        narrowed = await _create_link(
            client, {"scope": {"kind": "range", "from": "2024-02-01", "to": "2024-02-28"}}
        )
        whole = await _create_link(client)
        seen: list = []
        _install_llm(monkeypatch, seen=seen)
        assert (await _translate(client, narrowed["token"])).status_code == 200
        sent_ids = {
            def_id
            for call in seen
            for def_id, _name in call["items"]
            if not def_id.startswith("category:")
        }
        narrowed_record = await client.get(
            "/api/share/record", headers={SHARE_TOKEN_HEADER: narrowed["token"]}
        )
        whole_record = await client.get(
            "/api/share/record", headers={SHARE_TOKEN_HEADER: whole["token"]}
        )
        narrowed_ids = {b["definition"]["id"] for b in narrowed_record.json()["biomarkers"]}
        whole_ids = {b["definition"]["id"] for b in whole_record.json()["biomarkers"]}
        # Exactly the narrowed link's own biomarkers, and strictly fewer than
        # the whole record's: the scope narrows the batch too.
        assert sent_ids == narrowed_ids
        assert sent_ids < whole_ids


class TestShareTranslationCost:
    async def test_the_sdk_call_runs_off_the_event_loop(
        self, share_api, monkeypatch
    ):
        """ST4 review, F1.

        The Mistral SDK is synchronous and its client timeout is 300 s, so a
        call made inline from an `async def` route parks the event loop for the
        whole batch: no other request is served and not even SIGTERM is
        handled. One unauthenticated translate could wedge the backend.

        The assertion is the THREAD the call runs on, not a duration: the test
        coroutine itself runs on the event loop's thread, so a call that
        happens on that same thread is on the loop. Deterministic, and it
        would have failed on the pre-fix code.
        """
        client, _ = share_api
        created = await _create_link(client)
        seen: list[int] = []

        def recording(items, lang, _client, glossary=None):
            seen.append(threading.get_ident())
            return {def_id: f"{name}-{lang}" for def_id, name in items}

        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        monkeypatch.setattr("app.api.share._get_client", lambda: _fake_client())
        monkeypatch.setattr("app.api.share._translate_names_to_lang", recording)

        resp = await _translate(client, created["token"])

        assert resp.status_code == 200
        assert seen, "the translation seam must have been called"
        assert seen[0] != threading.get_ident(), (
            "the LLM call ran on the event loop — it must go through "
            "run_in_executor, the way /api/extract does its LLM work"
        )

    async def test_a_translate_in_flight_leaves_the_loop_serving(
        self, share_api, monkeypatch
    ):
        """The behavioural half of the same finding: while one translate is
        parked inside the SDK, a normal public read still answers.

        Ordering, not timing: the fake parks until the test releases it, and
        the assertion is that the read completed BEFORE the fake returned. On
        the pre-fix code the loop is blocked inside the fake, so the read
        cannot run until `release` — which the test only sets afterwards."""
        client, _ = share_api
        created = await _create_link(client)
        finished: list[float] = []
        started = threading.Event()
        release = threading.Event()

        def parked(items, lang, _client, glossary=None):
            started.set()
            release.wait(timeout=10)
            finished.append(time.monotonic())
            return {def_id: f"{name}-{lang}" for def_id, name in items}

        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        monkeypatch.setattr("app.api.share._get_client", lambda: _fake_client())
        monkeypatch.setattr("app.api.share._translate_names_to_lang", parked)

        task = asyncio.create_task(_translate(client, created["token"]))
        # Wait for the worker to be INSIDE the call. On the pre-fix code this
        # loop is itself blocked, which is the bug.
        deadline = time.monotonic() + 5
        while not started.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert started.is_set(), "the translation never started"

        status = await asyncio.wait_for(
            client.get(
                "/api/share/status", headers={SHARE_TOKEN_HEADER: created["token"]}
            ),
            timeout=3,
        )
        assert status.status_code == 200
        # The read finished while the SDK call was still parked: proof the loop
        # was free.
        assert finished == []

        release.set()
        assert (await asyncio.wait_for(task, timeout=5)).status_code == 200

    async def test_a_failed_executor_run_is_refunded(
        self, share_api, db_session, monkeypatch
    ):
        """The budget semantics survive the thread hop: a run reserved before a
        call that RAISES is given back. A soft LLM failure returns {} and is
        refunded by the `not combined` branch; this covers the harder path."""
        client, _ = share_api
        created = await _create_link(client)

        def explode(items, lang, _client, glossary=None):
            raise RuntimeError("SDK blew up in the worker thread")

        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        monkeypatch.setattr("app.api.share._get_client", lambda: _fake_client())
        monkeypatch.setattr("app.api.share._translate_names_to_lang", explode)

        with pytest.raises(RuntimeError):
            await _translate(client, created["token"])

        link = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).first()
        assert link.translate_runs_used == 0

    async def test_a_cancelled_run_is_refunded(
        self, share_api, db_session, monkeypatch
    ):
        """The thread hop makes cancellation reachable, so it has to refund.

        A client disconnect or a graceful shutdown cancels the request while
        the worker thread is still inside the (uncancellable) SDK call. Nobody
        receives that answer, so nobody should pay for it. `CancelledError` is
        a BaseException, which is why it has to be named explicitly.
        """
        client, _ = share_api
        created = await _create_link(client)
        started = threading.Event()
        release = threading.Event()

        def parked(items, lang, _client, glossary=None):
            started.set()
            release.wait(timeout=10)
            return {def_id: f"{name}-{lang}" for def_id, name in items}

        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        monkeypatch.setattr("app.api.share._get_client", lambda: _fake_client())
        monkeypatch.setattr("app.api.share._translate_names_to_lang", parked)

        task = asyncio.create_task(_translate(client, created["token"]))
        deadline = time.monotonic() + 5
        while not started.is_set() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert started.is_set()

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        release.set()

        link = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).first()
        assert link.translate_runs_used == 0

    async def test_cached_run_is_free(self, share_api, db_session, monkeypatch):
        """A run with no LLM work — every name already persisted for the
        language and every heading already in the shared cache — costs the
        recipient nothing, exactly as it costs the owner nothing."""
        client, _ = share_api
        created = await _create_link(client)
        _install_llm(monkeypatch)
        # Every seeded definition carries `de`; seed the heading cache too so
        # the German run really has nothing to ask the model.
        flowsheet = (
            await client.get(
                "/api/share/flowsheet", headers={SHARE_TOKEN_HEADER: created["token"]}
            )
        ).json()
        for category in {c["category"] for c in flowsheet["matrix"]}:
            cleaned = _clean_translation_name(category)
            db_session.add(
                CategoryTranslationCache(
                    id=_category_cache_id("de", cleaned),
                    original=cleaned,
                    translated=f"{cleaned}-de",
                )
            )
        db_session.commit()

        resp = await _translate(client, created["token"], lang="de")
        assert resp.status_code == 200
        body = resp.json()
        assert body["remaining"] == BUDGET
        assert any(item["source"] == "cached" for item in body["translations"])
        assert all(item["source"] != "translated" for item in body["translations"])
        link = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).first()
        assert link.translate_runs_used == 0

    async def test_failed_run_is_refunded(self, share_api, db_session, monkeypatch):
        client, _ = share_api
        created = await _create_link(client)
        _install_llm(monkeypatch, fail=True)

        resp = await _translate(client, created["token"])
        assert resp.status_code == 200
        assert resp.json()["remaining"] == BUDGET
        assert all(item["source"] == "fallback" for item in resp.json()["translations"])
        link = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).first()
        assert link.translate_runs_used == 0

    async def test_without_an_api_key_nothing_is_spent(
        self, share_api, db_session, monkeypatch
    ):
        client, _ = share_api
        created = await _create_link(client)
        monkeypatch.setattr("app.api.share._get_client", lambda: None)

        resp = await _translate(client, created["token"])
        assert resp.status_code == 200
        assert resp.json()["remaining"] == BUDGET
        link = db_session.query(ShareLink).filter(ShareLink.id == created["id"]).first()
        assert link.translate_runs_used == 0

    async def test_response_shape_matches_the_owner_endpoint(
        self, share_api, monkeypatch
    ):
        client, _ = share_api
        created = await _create_link(client)
        _install_llm(monkeypatch)
        body = (await _translate(client, created["token"])).json()
        assert set(body) == {"translations", "categories", "remaining"}
        assert set(body["translations"][0]) == {"id", "name", "source"}
        assert set(body["categories"][0]) == {"original", "translated", "source"}
