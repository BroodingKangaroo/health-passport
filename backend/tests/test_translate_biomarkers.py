import json
from datetime import datetime, timezone
from unittest.mock import Mock

from app.db.models import BiomarkerDefinition, UsageLimit
from config import REGISTERED_LIMITS
from tests.seed_data import TEST_USER_ID


def _seed_plain_def(db_session, id="local-test-1", user_id=TEST_USER_ID):
    defn = db_session.query(BiomarkerDefinition).filter(BiomarkerDefinition.id == id).first()
    if not defn:
        defn = BiomarkerDefinition(
            id=id,
            names={"en": "Test Biomarker"},
            synonyms=[],
            category="General",
            reference=None,
            unit="",
            scope="local",
            user_id=user_id,
            reference_source="pdf_extracted",
        )
        db_session.add(defn)
        db_session.commit()
    return defn


def _usage_count(db_session) -> int:
    usage = db_session.query(UsageLimit).filter(UsageLimit.user_id == TEST_USER_ID).first()
    return usage.ai_extraction_count if usage else 0


def _fake_client(payload=None, exc=None):
    client = Mock()
    if exc is not None:
        client.chat.parse.side_effect = exc
    else:
        client.chat.parse.return_value = Mock(
            choices=[Mock(message=Mock(content=json.dumps(payload)))]
        )
    return client


class TestTranslateBiomarkersEndpoint:
    async def test_already_translated_short_circuits_without_key_or_quota(
        self, client, db_session, monkeypatch
    ):
        """A def that already carries names[lang] is returned as-is: no LLM
        call, no quota charge (re-generates of a translated doc are free)."""
        monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
        # `wbc` from the test seed carries a full multilingual names map.
        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "wbc", "name": "WBC"}]},
        )
        assert resp.status_code == 200
        assert resp.json()["translations"] == [{"id": "wbc", "name": "Leukozyten"}]
        assert _usage_count(db_session) == 0

    async def test_without_api_key_returns_english_names_without_charge(
        self, client, db_session, monkeypatch
    ):
        """No MISTRAL_API_KEY: the request must succeed with English names and
        must never charge quota (the LLM call can never run)."""
        monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
        _seed_plain_def(db_session)
        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "local-test-1", "name": "Test Biomarker"}]},
        )
        assert resp.status_code == 200
        assert resp.json()["translations"] == [
            {"id": "local-test-1", "name": "Test Biomarker"}
        ]
        assert _usage_count(db_session) == 0
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-test-1"
        ).first()
        assert defn.names.get("de") is None

    async def test_persists_translation_and_charges_quota(self, client, db_session, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session)
        fake = _fake_client({"translations": [{"id": "local-test-1", "name": "Test-Biomarker"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "local-test-1", "name": "Test Biomarker"}]},
        )

        assert resp.status_code == 200
        assert resp.json()["translations"] == [
            {"id": "local-test-1", "name": "Test-Biomarker"}
        ]
        assert _usage_count(db_session) == 1
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-test-1"
        ).first()
        assert defn.names["de"] == "Test-Biomarker"
        assert defn.names["en"] == "Test Biomarker"

    async def test_polish_is_a_valid_target_language(self, client, db_session, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session)
        fake = _fake_client({"translations": [{"id": "local-test-1", "name": "Test-Biomarker"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "pl", "names": [{"id": "local-test-1", "name": "Test Biomarker"}]},
        )

        assert resp.status_code == 200
        assert resp.json()["translations"] == [
            {"id": "local-test-1", "name": "Test-Biomarker"}
        ]
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-test-1"
        ).first()
        assert defn.names["pl"] == "Test-Biomarker"

    async def test_llm_failure_refunds_and_keeps_english(self, client, db_session, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session)
        fake = _fake_client(exc=RuntimeError("LLM down"))
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "local-test-1", "name": "Test Biomarker"}]},
        )

        assert resp.status_code == 200
        assert resp.json()["translations"] == [
            {"id": "local-test-1", "name": "Test Biomarker"}
        ]
        assert _usage_count(db_session) == 0
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-test-1"
        ).first()
        assert "de" not in defn.names

    async def test_retries_ids_the_model_dropped_once(self, client, db_session, monkeypatch):
        """A response missing some ids triggers ONE retry call with only the
        missing ids; both translations land in the DB."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session, id="a")
        _seed_plain_def(db_session, id="b")
        fake = Mock()
        fake.chat.parse.side_effect = [
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "a", "name": "A-de"}]}
            )))]),
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "b", "name": "B-de"}]}
            )))]),
        ]
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]},
        )

        assert resp.status_code == 200
        assert {t["id"]: t["name"] for t in resp.json()["translations"]} == {"a": "A-de", "b": "B-de"}
        assert fake.chat.parse.call_count == 2
        # The retry call only carries the id the first response dropped.
        retry_prompt = fake.chat.parse.call_args_list[1].kwargs["messages"][0]["content"]
        assert '"a | A"' not in retry_prompt
        assert '"b | B"' in retry_prompt
        for def_id, translated in (("a", "A-de"), ("b", "B-de")):
            defn = db_session.query(BiomarkerDefinition).filter(
                BiomarkerDefinition.id == def_id
            ).first()
            assert defn.names["de"] == translated

    async def test_names_are_sanitized_and_empty_names_never_sent(
        self, client, db_session, monkeypatch
    ):
        """Newlines and the `|` delimiter are scrubbed out of names (a name
        must never smuggle extra prompt lines), and empty names are skipped
        so the model can't invent a translation for them."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session, id="a")
        _seed_plain_def(db_session, id="b")
        fake = Mock()
        fake.chat.parse.return_value = Mock(choices=[Mock(message=Mock(content=json.dumps(
            {"translations": []}
        )))])
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [
                    {"id": "a", "name": "Line1\nLine2 | X"},
                    {"id": "b", "name": "   "},
                ],
            },
        )

        assert resp.status_code == 200
        # First call carries only the sanitized, non-empty name; the retry
        # still never sees the empty name.
        assert fake.chat.parse.call_count == 2
        for call in fake.chat.parse.call_args_list:
            prompt = call.kwargs["messages"][0]["content"]
            assert "Line1\nLine2" not in prompt
            assert "Line1 Line2 X" in prompt
            assert '"b |"' not in prompt

    async def test_quota_exceeded_returns_429(self, client, db_session, monkeypatch):
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session)
        db_session.add(
            UsageLimit(
                user_id=TEST_USER_ID,
                is_anonymous=False,
                ai_extraction_count=REGISTERED_LIMITS["ai_extractions"],
                total_upload_size_bytes=0,
                last_activity=datetime.now(timezone.utc),
            )
        )
        db_session.commit()
        monkeypatch.setattr(
            "app.api.ai._get_client", lambda: _fake_client({"translations": []})
        )

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "local-test-1", "name": "Test Biomarker"}]},
        )

        assert resp.status_code == 429
        assert "translation limit reached" in resp.json()["detail"]

    async def test_foreign_definition_left_untouched(self, client, db_session, monkeypatch):
        monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
        _seed_plain_def(db_session, id="local-other", user_id="someone-else")

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "local-other", "name": "Other Biomarker"}]},
        )

        assert resp.status_code == 200
        assert resp.json()["translations"] == [
            {"id": "local-other", "name": "Other Biomarker"}
        ]
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-other"
        ).first()
        assert defn.names.get("de") is None

    async def test_unresolvable_id_keeps_requested_name(self, client, db_session, monkeypatch):
        monkeypatch.delenv("MISTRAL_API_KEY", raising=False)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "no-such-id", "name": "Ghost"}]},
        )

        assert resp.status_code == 200
        assert resp.json()["translations"] == [{"id": "no-such-id", "name": "Ghost"}]

    async def test_empty_names_returns_empty(self, client, db_session):
        resp = await client.post(
            "/api/translate-biomarkers", json={"lang": "de", "names": []}
        )
        assert resp.status_code == 200
        assert resp.json()["translations"] == []
