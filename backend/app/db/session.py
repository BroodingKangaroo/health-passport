import os
import re

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "sqlite:///./health_passport.db",
)

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args["check_same_thread"] = False

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# ISSUES.md #37: matcher-anchored local definitions used the tenant-blind id
# "local-{md5(name)[:12]}"; legacy rows matching this shape get renamed to the
# per-user scheme at startup.
_LEGACY_LOCAL_DEF_ID_RE = re.compile(r"^local-[0-9a-f]{12}$")


def migrate_add_columns(engine) -> None:
    """Idempotent in-place schema migration: adds any columns the model
    declares that the existing DB doesn't yet have. SQLAlchemy's
    ``create_all`` only creates missing tables, not missing columns on
    existing tables, so long-lived DBs would otherwise fall behind the
    schema (e.g. when a new column is added to a model)."""
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                # Build a portable CREATE COLUMN clause. Use the column's
                # compiled type so defaults / nullability are preserved.
                col_type = col.type.compile(engine.dialect)
                nullable = "" if col.nullable else " NOT NULL"
                default = ""
                if col.default is not None and col.default.is_scalar:
                    default = f" DEFAULT {col.default.arg!r}"
                conn.execute(text(
                    f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col_type}{nullable}{default}"
                ))


def migrate_local_definition_ids(engine) -> None:
    """Idempotent data migration (ISSUES.md #37): matcher-anchored local
    definitions used the tenant-blind id ``local-{md5(name)[:12]}`` — two
    users extracting the same novel analyte collided on one row. Every legacy
    row that has an owner is renamed to the per-user
    ``local-{user_id}-{md5}`` scheme the manual-entry path uses, with its
    readings remapped; when a same-owner definition with the target id already
    exists, the readings are remapped to it and the legacy row is deleted.
    Curated NULL-user sentinel locals (``local-opisthorchis-igg``) are not
    touched."""
    insp = inspect(engine)
    if not (
        insp.has_table("biomarker_definitions")
        and insp.has_table("biomarker_readings")
    ):
        return
    with engine.begin() as conn:
        rows = conn.execute(text(
            "SELECT id, user_id FROM biomarker_definitions "
            "WHERE id LIKE 'local-%' AND user_id IS NOT NULL"
        )).fetchall()
        for row in rows:
            if not _LEGACY_LOCAL_DEF_ID_RE.match(row.id):
                continue
            new_id = f"local-{row.user_id}-{row.id[len('local-'):]}"
            conn.execute(text(
                "UPDATE biomarker_readings SET biomarker_id = :new_id "
                "WHERE biomarker_id = :old_id"
            ), {"new_id": new_id, "old_id": row.id})
            taken = conn.execute(text(
                "SELECT 1 FROM biomarker_definitions WHERE id = :new_id"
            ), {"new_id": new_id}).first()
            if taken:
                conn.execute(text(
                    "DELETE FROM biomarker_definitions WHERE id = :old_id"
                ), {"old_id": row.id})
            else:
                conn.execute(text(
                    "UPDATE biomarker_definitions SET id = :new_id WHERE id = :old_id"
                ), {"new_id": new_id, "old_id": row.id})


def init_db():
    from app.db import models  # noqa: F401
    Base.metadata.create_all(bind=engine)
    migrate_add_columns(engine)
    migrate_local_definition_ids(engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
