"""Stage 3 S13: ``share_funnel_events.is_anonymous`` becomes nullable.

The migration is a SQLite table rebuild (SQLite has no ``ALTER COLUMN``);
this file proves it makes the column nullable, preserves rows, keeps the
``created_at`` index, and is idempotent — without touching the in-memory
test DBs the rest of the suite uses.
"""

from sqlalchemy import create_engine, inspect, text

from app.db import models  # noqa: F401  (registers tables on Base)
from app.db.session import Base, migrate_share_funnel_nullable


def _legacy_schema(conn) -> None:
    """The Stage 2 shape: the sender flag is NOT NULL with a default."""
    conn.execute(text(
        "CREATE TABLE share_funnel_events ("
        "id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "
        "event VARCHAR NOT NULL, "
        "is_anonymous BOOLEAN NOT NULL DEFAULT 1, "
        "created_at DATETIME"
        ")"
    ))
    conn.execute(text(
        "CREATE INDEX ix_share_funnel_events_created_at "
        "ON share_funnel_events (created_at)"
    ))
    conn.execute(text(
        "INSERT INTO share_funnel_events (event, is_anonymous, created_at) "
        "VALUES ('link_created', 0, '2026-09-01 10:00:00')"
    ))
    conn.execute(text(
        "INSERT INTO share_funnel_events (event, is_anonymous, created_at) "
        "VALUES ('link_revoked', 1, '2026-09-02 10:00:00')"
    ))


def _is_anonymous_nullable(engine) -> bool:
    columns = {c["name"]: c for c in inspect(engine).get_columns("share_funnel_events")}
    return columns["is_anonymous"]["nullable"]


def test_migration_makes_the_flag_nullable_and_preserves_rows(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as conn:
        _legacy_schema(conn)
    assert _is_anonymous_nullable(engine) is False

    migrate_share_funnel_nullable(engine)

    assert _is_anonymous_nullable(engine) is True
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT event, is_anonymous FROM share_funnel_events ORDER BY id")
        ).fetchall()
    assert rows == [("link_created", 0), ("link_revoked", 1)]
    index_names = [i["name"] for i in inspect(engine).get_indexes("share_funnel_events")]
    assert index_names == ["ix_share_funnel_events_created_at"]

    # Idempotent: a second pass is a no-op and loses nothing.
    migrate_share_funnel_nullable(engine)
    assert _is_anonymous_nullable(engine) is True
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM share_funnel_events")).scalar() == 2


def test_migration_is_a_noop_for_a_fresh_nullable_table(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'fresh.db'}")
    Base.metadata.create_all(bind=engine)
    assert _is_anonymous_nullable(engine) is True

    migrate_share_funnel_nullable(engine)
    assert _is_anonymous_nullable(engine) is True
