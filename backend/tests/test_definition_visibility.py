"""
Regression tests for ISSUES.md #43 (definition-id lookup IDOR):

- Client-supplied definition ids resolved against ANY row, including another
  tenant's local definition (whose id itself leaks the owner's user_id).
- The LOINC fallback used a nondeterministic ``.first()`` where the matcher
  ranks by global scope + COMMON_TEST_RANK.
"""
import hashlib
from typing import Optional

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api._serializers import (
    definition_visibility,
    resolve_definitions,
)
from app.api.entries import _resolve_definition
from app.api.timeline import _find_definition_by_id_or_loinc
from app.db.models import BiomarkerDefinition
from app.db.session import Base
from tests.seed_data import TEST_USER_ID, seed_test_db

FOREIGN_USER = "foreign-owner-uuid"


def _local_def_id(name: str) -> str:
    return f"local-{hashlib.md5(name.lower().encode()).hexdigest()[:12]}"


def _make_local(user_id: str, name: str, defn_id: Optional[str] = None) -> BiomarkerDefinition:
    return BiomarkerDefinition(
        id=defn_id or f"local-{user_id}-{hashlib.md5(name.lower().encode()).hexdigest()[:12]}",
        names={"en": name},
        synonyms=[name],
        category="General",
        reference=None,
        unit="mmol/L",
        scope="local",
        user_id=user_id,
        reference_source="local",
    )


@pytest.fixture(scope="function")
def vis_db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    session = TestingSessionLocal()
    seed_test_db(session)
    yield session
    session.close()
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def foreign_def(vis_db_session):
    defn = _make_local(FOREIGN_USER, "Foreign Private Analyte")
    vis_db_session.add(defn)
    vis_db_session.commit()
    return defn


class TestDefinitionIdOwnership:
    def test_resolve_definition_skips_foreign_local(
        self, vis_db_session, foreign_def
    ):
        """A client-supplied definition_id pointing at another tenant's local
        def must not resolve — the row falls through to the normal chain."""
        defn = _resolve_definition(
            vis_db_session,
            TEST_USER_ID,
            "Some Other Analyte",
            foreign_def.id,
            "General",
        )
        assert defn is not None
        assert defn.id != foreign_def.id
        assert defn.user_id == TEST_USER_ID

    def test_resolve_definition_fuzzy_still_skips_foreign(
        self, vis_db_session, foreign_def
    ):
        """Even an exact-name fuzzy hit on a foreign local def is refused."""
        defn = _resolve_definition(
            vis_db_session,
            TEST_USER_ID,
            "Foreign Private Analyte",
            None,
            "General",
        )
        assert defn.id != foreign_def.id
        assert defn.user_id == TEST_USER_ID

    def test_resolve_definition_still_resolves_own_local(
        self, vis_db_session, foreign_def
    ):
        own = _make_local(TEST_USER_ID, "My Own Analyte")
        vis_db_session.add(own)
        vis_db_session.commit()
        defn = _resolve_definition(
            vis_db_session, TEST_USER_ID, "irrelevant", own.id, "General"
        )
        assert defn.id == own.id

    def test_timeline_lookup_skips_foreign_local(
        self, vis_db_session, foreign_def
    ):
        assert (
            _find_definition_by_id_or_loinc(
                vis_db_session, foreign_def.id, TEST_USER_ID
            )
            is None
        )
        # The owner can still resolve it.
        assert (
            _find_definition_by_id_or_loinc(
                vis_db_session, foreign_def.id, FOREIGN_USER
            ).id
            == foreign_def.id
        )

    def test_resolve_definitions_map_excludes_foreign(
        self, vis_db_session, foreign_def
    ):
        by_id, _by_loinc = resolve_definitions(
            vis_db_session, {foreign_def.id}, TEST_USER_ID
        )
        assert foreign_def.id not in by_id


class TestDeterministicLoincFallback:
    @pytest.fixture
    def two_global_loinc_defs(self, vis_db_session):
        rare = BiomarkerDefinition(
            id="7777-1",
            loinc_code="7777-7",
            names={"en": "Rare Panel Variant"},
            synonyms=[],
            category="General",
            reference=None,
            unit="g/L",
            scope="global",
            common_rank=900,
        )
        common = BiomarkerDefinition(
            id="7777-2",
            loinc_code="7777-7",
            names={"en": "Common Panel Test"},
            synonyms=[],
            category="General",
            reference=None,
            unit="g/L",
            scope="global",
            common_rank=2,
        )
        vis_db_session.add_all([rare, common])
        vis_db_session.commit()
        return rare, common

    def test_loinc_fallback_prefers_lowest_common_rank(
        self, vis_db_session, two_global_loinc_defs
    ):
        _rare, common = two_global_loinc_defs
        for _ in range(3):  # deterministic across repeats
            defn = _find_definition_by_id_or_loinc(vis_db_session, "7777-7", TEST_USER_ID)
            assert defn.id == common.id

    def test_resolve_definitions_loinc_key_deterministic(
        self, vis_db_session, two_global_loinc_defs
    ):
        _rare, common = two_global_loinc_defs
        _by_id, by_loinc = resolve_definitions(
            vis_db_session, {"7777-7"}, TEST_USER_ID
        )
        assert by_loinc["7777-7"].id == common.id

    def test_visibility_predicate_shape(self):
        clause = str(
            definition_visibility(TEST_USER_ID).compile(
                dialect=None, compile_kwargs={"literal_binds": True}
            )
        )
        assert "scope" in clause and "user_id" in clause


class TestLikeWildcardEscaping:
    """ISSUES.md #56: the fuzzy-resolution ILIKE used a client-supplied name
    as a LIKE pattern unescaped — a name of '%' matched arbitrary existing
    definitions instead of behaving literally."""

    def test_wildcard_name_is_matched_literally(self, vis_db_session):
        from app.api.entries import _escape_like

        assert _escape_like("100% glu") == "100\\% glu"
        assert _escape_like("a_b") == "a\\_b"
        assert _escape_like("a\\b") == "a\\\\b"

        # A bare '%' row must NOT resolve to any seeded definition — it
        # becomes its own local definition.
        defn = _resolve_definition(vis_db_session, "wildcard-user", "%", None, "General")
        assert defn is not None
        assert defn.user_id == "wildcard-user"
        assert defn.names["en"] == "%"
        assert defn.scope == "local"

    def test_underscore_name_is_matched_literally(self, vis_db_session):
        # An underscore must not act as a single-char wildcard: "G_u%ose"
        # must not substring-match seeded synonyms like "Glucose".
        defn = _resolve_definition(
            vis_db_session, "wildcard-user", "zz_quiet_nope", None, "General"
        )
        assert defn is not None
        assert defn.user_id == "wildcard-user"
        assert defn.names["en"] == "zz_quiet_nope"

    def test_regular_names_still_fuzzy_match(self, vis_db_session):
        defn = _resolve_definition(
            vis_db_session, "wildcard-user", "Glucose", None, "General"
        )
        assert defn is not None
        assert defn.scope in ("global", "local")
