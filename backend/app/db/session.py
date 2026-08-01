import os

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, declarative_base

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


def init_db():
    from app.db import models  # noqa: F401
    Base.metadata.create_all(bind=engine)
    migrate_add_columns(engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
