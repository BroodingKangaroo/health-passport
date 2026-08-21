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
        fake = _fake_client({"translations": [{"id": "t1", "name": "Test-Biomarker"}]})
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
        fake = _fake_client({"translations": [{"id": "t1", "name": "Test-Biomarker"}]})
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
                {"translations": [{"id": "t1", "name": "A-de"}]}
            )))]),
            # Retry call carries only b, so its token restarts at t1.
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "t1", "name": "B-de"}]}
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
        assert '"t1 | A"' not in retry_prompt
        assert '"t1 | B"' in retry_prompt
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
        # still never sees the empty name (the straggler pass makes a third
        # call since the model returned nothing twice).
        assert fake.chat.parse.call_count == 3
        for call in fake.chat.parse.call_args_list:
            prompt = call.kwargs["messages"][0]["content"]
            assert "Line1\nLine2" not in prompt
            assert "Line1 Line2 X" in prompt
            assert '"t2 |"' not in prompt

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

    async def test_truncated_and_fence_wrapped_responses_are_recovered(
        self, client, db_session, monkeypatch
    ):
        """A truncated response fails to parse and is retried once; a
        code-fence-wrapped response parses on the first try (here in the
        straggler pass). All translations land in the DB."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session, id="a")
        _seed_plain_def(db_session, id="b")
        fake = Mock()
        fake.chat.parse.side_effect = [
            # a: truncated mid-JSON -> parse fails, whole chunk retried once
            Mock(choices=[Mock(message=Mock(
                content='{"translations": [{"id": "t1", "name": "A-de"}]'
            ))]),
            # Retry carries the whole chunk (a, b) with fresh t1/t2 tokens;
            # the model answers only a, so b falls through to the straggler.
            Mock(choices=[Mock(message=Mock(
                content='```json\n{"translations": [{"id": "t1", "name": "A-de"}]}\n```'
            ))]),
            # Straggler call carries only b, so its token restarts at t1.
            Mock(choices=[Mock(message=Mock(
                content='```\n{"translations": [{"id": "t1", "name": "B-de"}]}\n```'
            ))]),
        ]
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]},
        )

        assert resp.status_code == 200
        assert fake.chat.parse.call_count == 3
        assert {t["id"]: t["name"] for t in resp.json()["translations"]} == {"a": "A-de", "b": "B-de"}
        for def_id, translated in (("a", "A-de"), ("b", "B-de")):
            defn = db_session.query(BiomarkerDefinition).filter(
                BiomarkerDefinition.id == def_id
            ).first()
            assert defn.names["de"] == translated

    async def test_large_dictionary_is_chunked(self, client, db_session, monkeypatch):
        """50 names span two chunks (45 + 5); every id is translated and
        persisted; token numbering restarts per chunk."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        def_ids = [f"d{i:02d}" for i in range(50)]
        for def_id in def_ids:
            _seed_plain_def(db_session, id=def_id)
        fake = Mock()
        fake.chat.parse.side_effect = [
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": f"t{i + 1}", "name": f"C1-{i + 1}"} for i in range(45)]}
            )))]),
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": f"t{i + 1}", "name": f"C2-{i + 1}"} for i in range(5)]}
            )))]),
        ]
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": d, "name": "Test Biomarker"} for d in def_ids],
            },
        )

        assert resp.status_code == 200
        assert fake.chat.parse.call_count == 2
        first_prompt = fake.chat.parse.call_args_list[0].kwargs["messages"][0]["content"]
        second_prompt = fake.chat.parse.call_args_list[1].kwargs["messages"][0]["content"]
        assert '"t45 |' in first_prompt
        assert '"t46 |' not in first_prompt
        assert '"t1 |' in second_prompt
        assert {t["id"]: t["name"] for t in resp.json()["translations"]} == {
            **{f"d{i:02d}": f"C1-{i + 1}" for i in range(45)},
            **{f"d{i:02d}": f"C2-{i - 44}" for i in range(45, 50)},
        }
        for i, def_id in enumerate(def_ids):
            defn = db_session.query(BiomarkerDefinition).filter(
                BiomarkerDefinition.id == def_id
            ).first()
            assert defn.names["de"] == (f"C1-{i + 1}" if i < 45 else f"C2-{i - 44}")

    async def test_chunk_failure_keeps_earlier_chunks_and_straggler_pass(
        self, client, db_session, monkeypatch
    ):
        """A chunk whose LLM calls fail does not lose earlier chunks: the
        failed ids fall through to the straggler pass and still translate."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        monkeypatch.setattr("app.api.ai.TRANSLATE_CHUNK_SIZE", 1)
        _seed_plain_def(db_session, id="a")
        _seed_plain_def(db_session, id="b")
        fake = Mock()
        fake.chat.parse.side_effect = [
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "t1", "name": "A-de"}]}
            )))]),
            RuntimeError("LLM down"),  # chunk for b: first call fails
            RuntimeError("LLM down"),  # chunk for b: retry also fails
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "t1", "name": "B-de"}]}
            )))]),  # straggler pass recovers b
        ]
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]},
        )

        assert resp.status_code == 200
        assert fake.chat.parse.call_count == 4
        assert {t["id"]: t["name"] for t in resp.json()["translations"]} == {"a": "A-de", "b": "B-de"}
        for def_id, translated in (("a", "A-de"), ("b", "B-de")):
            defn = db_session.query(BiomarkerDefinition).filter(
                BiomarkerDefinition.id == def_id
            ).first()
            assert defn.names["de"] == translated

    async def test_glossary_seeds_translation_prompts(self, client, db_session, monkeypatch):
        """A def already translated (short-circuited) seeds the glossary so
        the new batch matches its style."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session, id="local-test-1")
        fake = Mock()
        fake.chat.parse.return_value = Mock(choices=[Mock(message=Mock(content=json.dumps(
            {"translations": [{"id": "t1", "name": "Test-Biomarker"}]}
        )))])
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [
                    {"id": "wbc", "name": "WBC"},  # seed def already has names.de="Leukozyten"
                    {"id": "local-test-1", "name": "Test Biomarker"},
                ],
            },
        )

        assert resp.status_code == 200
        assert fake.chat.parse.call_count == 1
        prompt = fake.chat.parse.call_args.kwargs["messages"][0]["content"]
        assert "Reference translations" in prompt
        assert "Leukozyten" in prompt

    async def test_mangled_and_duplicate_tokens_are_handled(self, client, db_session, monkeypatch):
        """Unknown tokens are skipped, duplicate tokens are last-wins, and a
        missing token is recovered by the drop-retry."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session, id="a")
        _seed_plain_def(db_session, id="b")
        fake = Mock()
        fake.chat.parse.side_effect = [
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {
                    "translations": [
                        {"id": "t2", "name": "B-first"},
                        {"id": "t2", "name": "B-de"},  # duplicate: last wins
                        {"id": "no-such-token", "name": "Ghost"},  # unknown: skipped
                    ]
                }
            )))]),
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "t1", "name": "A-de"}]}
            )))]),  # drop-retry recovers a
        ]
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]},
        )

        assert resp.status_code == 200
        assert fake.chat.parse.call_count == 2
        assert {t["id"]: t["name"] for t in resp.json()["translations"]} == {"a": "A-de", "b": "B-de"}
        defn_a = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "a"
        ).first()
        defn_b = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "b"
        ).first()
        assert defn_a.names["de"] == "A-de"
        assert defn_b.names["de"] == "B-de"
