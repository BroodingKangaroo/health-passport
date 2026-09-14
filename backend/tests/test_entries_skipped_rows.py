"""`skipped_rows` accounting in the save/merge biomarker parser: partially
filled rows are counted (the client warns), fully blank editor placeholders
are not."""

from app.api.entries import _parse_biomarker_rows
from app.db.session import SessionLocal


def test_parse_biomarker_rows_counts_partial_rows_only():
    db = SessionLocal()
    try:
        categories = [{
            "name": "General",
            "rows": [
                {"name": "", "value": ""},   # untouched placeholder — not counted
                {"name": "X", "value": ""},  # name without value — counted
                {"name": "", "value": "5"},  # value without name — counted
            ],
        }]
        specs, skipped = _parse_biomarker_rows(db, "u_skipped", categories)
        assert specs == []
        assert skipped == 2
    finally:
        db.close()
