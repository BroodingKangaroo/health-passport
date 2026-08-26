import json
from datetime import datetime, timezone
from unittest.mock import Mock

import pytest_asyncio
from fastapi import FastAPI, Request, Response
from httpx import ASGITransport, AsyncClient

from app.db.models import BiomarkerDefinition, UsageLimit
from app.db.session import get_db
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
        assert resp.json()["translations"] == [
            {"id": "wbc", "name": "Leukozyten", "source": "cached"}
        ]
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
            {"id": "local-test-1", "name": "Test Biomarker", "source": "fallback"}
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
            {"id": "local-test-1", "name": "Test-Biomarker", "source": "translated"}
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
            {"id": "local-test-1", "name": "Test-Biomarker", "source": "translated"}
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
            {"id": "local-test-1", "name": "Test Biomarker", "source": "fallback"}
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
        # still never sees the empty name. The model returns nothing, so the
        # straggler pass makes TWO more calls (call + drop-retry) before
        # giving up on it.
        assert fake.chat.parse.call_count == 4
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
            {"id": "local-other", "name": "Other Biomarker", "source": "fallback"}
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
        assert resp.json()["translations"] == [
            {"id": "no-such-id", "name": "Ghost", "source": "fallback"}
        ]

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

    async def test_straggler_pass_retries_before_falling_back(
        self, client, db_session, monkeypatch
    ):
        """The straggler pass (last chance before English fallback) now has
        its own drop-retry: an id the straggler's first call missed is retried
        once in a smaller call instead of falling back to English."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session, id="a")
        _seed_plain_def(db_session, id="b")
        fake = Mock()
        fake.chat.parse.side_effect = [
            # Pass 1 chunk (a, b): model answers only a.
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "t1", "name": "A-de"}]}
            )))]),
            # Pass 1 drop-retry for b: fails outright.
            RuntimeError("LLM down"),
            # Straggler call for b: model returns nothing usable.
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": []}
            )))]),
            # Straggler drop-retry recovers b — no English fallback.
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
        assert fake.chat.parse.call_count == 4
        assert {t["id"]: t["name"] for t in resp.json()["translations"]} == {"a": "A-de", "b": "B-de"}
        defn_b = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "b"
        ).first()
        assert defn_b.names["de"] == "B-de"

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

    async def test_empty_response_for_known_token_keeps_input_name(
        self, client, db_session, monkeypatch
    ):
        """A known token answered with an empty string means 'untranslatable':
        the input name is kept and the id is NOT dropped into retry/straggler
        (which previously surfaced a false English fallback for Latin names
        like 'Escherichia coli')."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session, id="eco")
        fake = Mock()
        fake.chat.parse.return_value = Mock(choices=[Mock(message=Mock(content=json.dumps(
            {"translations": [{"id": "t1", "name": ""}]}
        )))])
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "eco", "name": "Escherichia coli"}]},
        )

        assert resp.status_code == 200
        # Kept as-is in ONE call — no drop-retry, no straggler pass.
        assert fake.chat.parse.call_count == 1
        assert resp.json()["translations"] == [
            {"id": "eco", "name": "Escherichia coli", "source": "translated"}
        ]
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "eco"
        ).first()
        assert defn.names["de"] == "Escherichia coli"

    async def test_prompt_forbids_omitting_unchanged_items(
        self, client, db_session, monkeypatch
    ):
        """The prompt explicitly requires echoing every token, even when the
        name stays unchanged (Latin terms) — omission caused false fallbacks."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session)
        fake = _fake_client({"translations": [{"id": "t1", "name": "Test-Biomarker"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "local-test-1", "name": "Test Biomarker"}]},
        )

        assert resp.status_code == 200
        prompt = fake.chat.parse.call_args.kwargs["messages"][0]["content"]
        assert "NEVER omit an item" in prompt

    async def test_prompt_handles_non_english_headings_and_class_codes(
        self, client, db_session, monkeypatch
    ):
        """Panel headings arrive in the source document's language (not always
        English) and must still be translated; LOINC-style class codes must
        stay verbatim instead of being half-translated (HEM/BC -> HEM/CE)."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session)
        fake = _fake_client({"translations": [{"id": "t1", "name": "Test-Biomarker"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": "local-test-1", "name": "Test Biomarker"}],
                "categories": ["Клинический анализ крови", "HEM/BC"],
            },
        )

        assert resp.status_code == 200
        prompt = fake.chat.parse.call_args.kwargs["messages"][0]["content"]
        assert "may arrive in another language" in prompt
        assert "never echo an item back in a language other than" in prompt
        assert "EXACTLY unchanged" in prompt
        assert "HEM/BC" in prompt  # cited as a verbatim class-code example

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

    async def test_source_classification_mixed_batch(self, client, db_session, monkeypatch):
        """One response classifies each item: newly translated, already
        persisted (cached), and unresolvable (fallback)."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session, id="new-def")
        fake = _fake_client({"translations": [{"id": "t1", "name": "Neu-Biomarker"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [
                    {"id": "wbc", "name": "WBC"},  # seed def: names.de already set
                    {"id": "new-def", "name": "Test Biomarker"},
                    {"id": "no-such-id", "name": "Ghost"},
                ],
            },
        )

        assert resp.status_code == 200
        assert resp.json()["translations"] == [
            {"id": "wbc", "name": "Leukozyten", "source": "cached"},
            {"id": "new-def", "name": "Neu-Biomarker", "source": "translated"},
            {"id": "no-such-id", "name": "Ghost", "source": "fallback"},
        ]

    async def test_rate_limit_aborts_remaining_chunks(self, client, db_session, monkeypatch):
        """A Mistral 429 that surfaces after the SDK's own retries aborts the
        remaining chunks (no retry/straggler calls): earlier chunks keep their
        translations, the rest fall back to English, quota stays charged."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        monkeypatch.setattr("app.api.ai.TRANSLATE_CHUNK_SIZE", 1)
        _seed_plain_def(db_session, id="a")
        _seed_plain_def(db_session, id="b")
        _seed_plain_def(db_session, id="c")

        class _FakeRateLimitError(Exception):
            status_code = 429

        fake = Mock()
        fake.chat.parse.side_effect = [
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "t1", "name": "A-de"}]}
            )))]),
            _FakeRateLimitError("Status 429: rate limited"),
        ]
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}, {"id": "c", "name": "C"}],
            },
        )

        assert resp.status_code == 200
        # Chunk a succeeded; the 429 on chunk b aborted everything after it
        # (no drop-retry for b, no straggler pass for b/c).
        assert fake.chat.parse.call_count == 2
        by_id = {t["id"]: t for t in resp.json()["translations"]}
        assert by_id["a"] == {"id": "a", "name": "A-de", "source": "translated"}
        assert by_id["b"] == {"id": "b", "name": "B", "source": "fallback"}
        assert by_id["c"] == {"id": "c", "name": "C", "source": "fallback"}
        # Partial success is kept and persisted — no refund (the LLM ran).
        assert _usage_count(db_session) == 1
        defn_a = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "a"
        ).first()
        assert defn_a.names["de"] == "A-de"

    async def test_generic_llm_error_is_not_treated_as_rate_limit(
        self, client, db_session, monkeypatch
    ):
        """A non-429 LLM error keeps the existing behavior: chunk retry +
        straggler pass still run instead of aborting early."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        monkeypatch.setattr("app.api.ai.TRANSLATE_CHUNK_SIZE", 1)
        _seed_plain_def(db_session, id="a")
        _seed_plain_def(db_session, id="b")
        fake = Mock()
        fake.chat.parse.side_effect = [
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "t1", "name": "A-de"}]}
            )))]),
            RuntimeError("LLM down"),  # b first call
            RuntimeError("LLM down"),  # b retry
            Mock(choices=[Mock(message=Mock(content=json.dumps(
                {"translations": [{"id": "t1", "name": "B-de"}]}
            )))]),  # straggler recovers b
        ]
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]},
        )

        assert resp.status_code == 200
        assert fake.chat.parse.call_count == 4
        assert {t["id"]: t["name"] for t in resp.json()["translations"]} == {"a": "A-de", "b": "B-de"}


class TestCategoryTranslation:
    async def test_categories_translate_in_same_batch_as_names(
        self, client, db_session, monkeypatch
    ):
        """Names and categories share one LLM call (categories ride synthetic
        ids); the response classifies each; nothing about categories is
        persisted and quota is charged once."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session)
        fake = _fake_client({"translations": [
            {"id": "t1", "name": "Test-Biomarker"},
            {"id": "t2", "name": "Blutbild"},
            {"id": "t3", "name": "Lipidpanel"},
        ]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": "local-test-1", "name": "Test Biomarker"}],
                "categories": ["Complete Blood Count", "Lipid Panel"],
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["translations"] == [
            {"id": "local-test-1", "name": "Test-Biomarker", "source": "translated"}
        ]
        assert body["categories"] == [
            {"original": "Complete Blood Count", "translated": "Blutbild", "source": "translated"},
            {"original": "Lipid Panel", "translated": "Lipidpanel", "source": "translated"},
        ]
        # One batched call carrying both names and category strings.
        assert fake.chat.parse.call_count == 1
        prompt = fake.chat.parse.call_args.kwargs["messages"][0]["content"]
        assert '"t2 | Complete Blood Count"' in prompt
        assert '"t3 | Lipid Panel"' in prompt
        assert _usage_count(db_session) == 1

    async def test_category_only_request_translates_without_names(
        self, client, db_session, monkeypatch
    ):
        """A request with categories but NO names still reaches the LLM (the
        empty-names guard must not short-circuit it)."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        fake = _fake_client({"translations": [{"id": "t1", "name": "Schilddrüsenpanel"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [], "categories": ["Thyroid Panel"]},
        )

        assert resp.status_code == 200
        assert resp.json()["translations"] == []
        assert resp.json()["categories"] == [
            {"original": "Thyroid Panel", "translated": "Schilddrüsenpanel", "source": "translated"}
        ]
        assert fake.chat.parse.call_count == 1
        assert _usage_count(db_session) == 1

    async def test_categories_fall_back_on_total_llm_failure(
        self, client, db_session, monkeypatch
    ):
        """When the LLM fails outright, categories come back as their original
        English strings with source=fallback, quota is refunded, and nothing
        is persisted."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session)
        fake = _fake_client(exc=RuntimeError("LLM down"))
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": "local-test-1", "name": "Test Biomarker"}],
                "categories": ["Lipid Panel"],
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["translations"][0]["source"] == "fallback"
        assert body["categories"] == [
            {"original": "Lipid Panel", "translated": "Lipid Panel", "source": "fallback"}
        ]
        assert _usage_count(db_session) == 0

    async def test_cached_names_with_new_categories_still_call_llm(
        self, client, db_session, monkeypatch
    ):
        """All names already translated (cached) + new categories: the request
        proceeds so only the categories are translated in the batch."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        fake = _fake_client({"translations": [{"id": "t1", "name": "Vitamine"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": "wbc", "name": "WBC"}],  # seed def: names.de set
                "categories": ["Vitamins"],
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["translations"] == [
            {"id": "wbc", "name": "Leukozyten", "source": "cached"}
        ]
        assert body["categories"] == [
            {"original": "Vitamins", "translated": "Vitamine", "source": "translated"}
        ]
        assert fake.chat.parse.call_count == 1
        prompt = fake.chat.parse.call_args.kwargs["messages"][0]["content"]
        assert '"t1 | Vitamins"' in prompt
        assert "| WBC" not in prompt

    async def test_categories_dedupe_after_sanitization_and_skip_empty(
        self, client, db_session, monkeypatch
    ):
        """Whitespace variants of one heading collapse to a single item keyed
        by the FIRST raw spelling; empty/whitespace-only strings never reach
        the model."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        fake = _fake_client({"translations": [
            {"id": "t1", "name": "Lipidpanel"},
            {"id": "t2", "name": "CBC-de"},
        ]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [],
                "categories": ["Lipid Panel", "  Lipid \n Panel ", "", "   ", "CBC"],
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert [c["original"] for c in body["categories"]] == ["Lipid Panel", "CBC"]
        assert [c["translated"] for c in body["categories"]] == ["Lipidpanel", "CBC-de"]
        assert fake.chat.parse.call_count == 1
        prompt = fake.chat.parse.call_args.kwargs["messages"][0]["content"]
        assert prompt.count("| Lipid") == 1
        assert '"t2 | CBC"' in prompt

    async def test_empty_request_returns_empty_for_both(self, client, db_session):
        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [], "categories": []},
        )
        assert resp.status_code == 200
        assert resp.json() == {"translations": [], "categories": []}


class TestTranslationReviewFlow:
    async def test_persist_false_returns_translations_without_saving(
        self, client, db_session, monkeypatch
    ):
        """persist=False (review flow): fresh translations come back in the
        response but names[lang] is NOT written; quota stays charged (the LLM
        ran)."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        _seed_plain_def(db_session)
        fake = _fake_client({"translations": [{"id": "t1", "name": "Test-Biomarker"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": "local-test-1", "name": "Test Biomarker"}],
                "persist": False,
            },
        )

        assert resp.status_code == 200
        # Response carries the FRESH translation even though nothing persisted.
        assert resp.json()["translations"] == [
            {"id": "local-test-1", "name": "Test-Biomarker", "source": "translated"}
        ]
        assert _usage_count(db_session) == 1
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-test-1"
        ).first()
        assert defn.names.get("de") is None

    async def test_commit_persists_accepted_names_without_llm_or_quota(
        self, client, db_session, monkeypatch
    ):
        """The commit endpoint writes the reviewed names verbatim: no LLM
        client, no quota charge, foreign/unresolvable ids skipped."""
        monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
        _seed_plain_def(db_session, id="a")
        _seed_plain_def(db_session, id="local-other", user_id="someone-else")

        resp = await client.post(
            "/api/translate-biomarkers/commit",
            json={
                "lang": "pl",
                "items": [
                    {"id": "a", "name": "Test-Biomarker-PL"},
                    {"id": "local-other", "name": "Foreign-PL"},  # foreign: skipped
                    {"id": "no-such-id", "name": "Ghost-PL"},  # unknown: skipped
                    {"id": "a", "name": ""},  # duplicate id, empty name: skipped
                ],
            },
        )

        assert resp.status_code == 200
        assert resp.json() == {"saved": 1}
        assert _usage_count(db_session) == 0
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "a"
        ).first()
        assert defn.names["pl"] == "Test-Biomarker-PL"
        other = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "local-other"
        ).first()
        assert other.names.get("pl") is None


class TestCategoryTranslationCache:
    def _cache_id(self, lang: str, cleaned: str) -> str:
        import hashlib

        return f"{lang}:{hashlib.sha256(cleaned.encode()).hexdigest()}"

    def _seed_cache(self, db_session, lang: str, original: str, translated: str):
        from app.db.models import CategoryTranslationCache

        db_session.add(
            CategoryTranslationCache(
                id=self._cache_id(lang, original),
                original=original,
                translated=translated,
            )
        )
        db_session.commit()

    async def test_repeat_category_request_is_served_from_cache(
        self, client, db_session, monkeypatch
    ):
        """The second identical request hits the shared cache: zero new LLM
        calls, zero new quota — the heading is translated exactly once."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        fake = _fake_client({"translations": [{"id": "t1", "name": "Lipidpanel"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        body = {"lang": "de", "names": [], "categories": ["Lipid Panel"]}
        first = await client.post("/api/translate-biomarkers", json=body)
        assert first.status_code == 200
        assert first.json()["categories"] == [
            {"original": "Lipid Panel", "translated": "Lipidpanel", "source": "translated"}
        ]
        assert fake.chat.parse.call_count == 1
        assert _usage_count(db_session) == 1

        second = await client.post("/api/translate-biomarkers", json=body)
        assert second.status_code == 200
        assert second.json()["categories"] == first.json()["categories"]
        # Served entirely from the cache: no LLM call, no quota charge.
        assert fake.chat.parse.call_count == 1
        assert _usage_count(db_session) == 1

    async def test_partial_cache_hit_only_sends_misses(
        self, client, db_session, monkeypatch
    ):
        """Cached headings never reach the prompt; misses translate fresh and
        the response merges both."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        self._seed_cache(db_session, "de", "Lipid Panel", "Lipidpanel")
        fake = _fake_client({"translations": [{"id": "t1", "name": "Vitamine"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [],
                "categories": ["Lipid Panel", "Vitamins"],
            },
        )

        assert resp.status_code == 200
        assert fake.chat.parse.call_count == 1
        prompt = fake.chat.parse.call_args.kwargs["messages"][0]["content"]
        assert '"t1 | Vitamins"' in prompt
        assert "| Lipid Panel" not in prompt
        assert resp.json()["categories"] == [
            {"original": "Lipid Panel", "translated": "Lipidpanel", "source": "translated"},
            {"original": "Vitamins", "translated": "Vitamine", "source": "translated"},
        ]

    async def test_successful_run_writes_cache_rows(
        self, client, db_session, monkeypatch
    ):
        """Fresh heading translations land in the shared cache table keyed by
        lang + sha256 of the cleaned heading."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        fake = _fake_client({"translations": [{"id": "t1", "name": "Blutbild"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [], "categories": ["Complete Blood Count"]},
        )

        assert resp.status_code == 200
        from app.db.models import CategoryTranslationCache

        row = db_session.query(CategoryTranslationCache).filter(
            CategoryTranslationCache.id == self._cache_id("de", "Complete Blood Count")
        ).first()
        assert row is not None
        assert row.original == "Complete Blood Count"
        assert row.translated == "Blutbild"

    async def test_all_cached_names_and_headings_return_free(
        self, client, db_session, monkeypatch
    ):
        """Persisted names + cached headings: the request short-circuits with
        no LLM call and no quota (a fully-cached document regenerates free)."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        self._seed_cache(db_session, "de", "Complete Blood Count", "Blutbild")
        fake = _fake_client({"translations": []})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": "wbc", "name": "WBC"}],  # seed def: names.de set
                "categories": ["Complete Blood Count"],
            },
        )

        assert resp.status_code == 200
        assert resp.json()["translations"] == [
            {"id": "wbc", "name": "Leukozyten", "source": "cached"}
        ]
        assert resp.json()["categories"] == [
            {"original": "Complete Blood Count", "translated": "Blutbild", "source": "translated"}
        ]
        assert fake.chat.parse.call_count == 0
        assert _usage_count(db_session) == 0

    async def test_llm_failure_still_returns_cached_headings(
        self, client, db_session, monkeypatch
    ):
        """Total LLM failure: quota refunded, names fall back to English, but
        cached headings stay valid and are still returned."""
        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        self._seed_cache(db_session, "de", "Lipid Panel", "Lipidpanel")
        _seed_plain_def(db_session)
        fake = _fake_client(exc=RuntimeError("LLM down"))
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": "local-test-1", "name": "Test Biomarker"}],
                "categories": ["Lipid Panel"],
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["translations"][0]["source"] == "fallback"
        assert body["categories"] == [
            {"original": "Lipid Panel", "translated": "Lipidpanel", "source": "translated"}
        ]
        assert _usage_count(db_session) == 0


@pytest_asyncio.fixture
async def anon_client(db_session):
    """An unauthenticated client: get_current_user_or_anon resolves to an
    anonymous session. Used to prove the write endpoints reject anon writes."""
    from app.api.ai import router as ai_router
    from app.api.auth import get_current_user_or_anon

    app = FastAPI()
    app.include_router(ai_router)

    async def override_get_db():
        yield db_session

    async def override_get_current_user_or_anon(request: Request, response: Response):
        return (None, "anon-session-id", True)

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user_or_anon] = override_get_current_user_or_anon

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


class TestTranslationSecurityGating:
    async def test_anonymous_commit_is_forbidden(self, anon_client, db_session):
        """ISSUES.md #32: an anonymous caller must not rewrite shared (global)
        definitions. The commit endpoint returns 403 and writes nothing."""
        resp = await anon_client.post(
            "/api/translate-biomarkers/commit",
            json={"lang": "de", "items": [{"id": "wbc", "name": "Poisoned"}]},
        )
        assert resp.status_code == 403
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "wbc"
        ).first()
        # The seeded translation is untouched; the anonymous payload was rejected.
        assert defn.names.get("de") == "Leukozyten"
        assert defn.names.get("de") != "Poisoned"

    async def test_anonymous_persist_does_not_write_shared_definitions(
        self, anon_client, db_session, monkeypatch
    ):
        """ISSUES.md #32: persist=True from an anonymous caller must still return
        the translation for this render but must NOT persist it onto the shared
        (global) definition."""
        # A fresh, untranslated global definition (user_id None) so the LLM would
        # actually run for it (a def that already carries names[lang] is skipped
        # before the LLM call).
        db_session.add(
            BiomarkerDefinition(
                id="global-fresh",
                names={"en": "Fresh Biomarker"},
                synonyms=[],
                category="General",
                reference=None,
                unit="",
                scope="global",
                user_id=None,
                reference_source="global",
            )
        )
        db_session.commit()

        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        fake = _fake_client({"translations": [{"id": "t1", "name": "Poisoned-DE"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await anon_client.post(
            "/api/translate-biomarkers",
            json={
                "lang": "de",
                "names": [{"id": "global-fresh", "name": "Fresh Biomarker"}],
                "persist": True,
            },
        )

        assert resp.status_code == 200
        # The render still carries the translation (in-response only)...
        assert resp.json()["translations"][0]["name"] == "Poisoned-DE"
        # ...but the shared global definition is untouched (no poisoning).
        defn = db_session.query(BiomarkerDefinition).filter(
            BiomarkerDefinition.id == "global-fresh"
        ).first()
        assert defn.names.get("de") is None

    async def test_anonymous_does_not_poison_category_cache(
        self, anon_client, db_session, monkeypatch
    ):
        """ISSUES.md #33: an anonymous caller must not be able to seed the shared
        category_translation_cache (which every user's print render trusts)."""
        import hashlib

        from app.db.models import CategoryTranslationCache

        monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
        fake = _fake_client({"translations": [{"id": "t1", "name": "Poisoned-Heading"}]})
        monkeypatch.setattr("app.api.ai._get_client", lambda: fake)

        resp = await anon_client.post(
            "/api/translate-biomarkers",
            json={"lang": "de", "names": [], "categories": ["Complete Blood Count"]},
        )

        assert resp.status_code == 200
        cache_id = f"de:{hashlib.sha256(b'Complete Blood Count').hexdigest()}"
        row = db_session.query(CategoryTranslationCache).filter(
            CategoryTranslationCache.id == cache_id
        ).first()
        assert row is None
