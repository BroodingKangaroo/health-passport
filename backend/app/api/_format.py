from datetime import datetime, timezone
from typing import Optional


def _current_year() -> int:
    return datetime.now(timezone.utc).year


def format_biomarker_range(
    range_min: Optional[float], range_max: Optional[float], unit: str = ""
) -> str:
    """Format a reference range without leaking ``None`` into the output.

    One-sided ranges render as a lower/upper bound (``>= min`` / ``<= max``)
    instead of the previous ``"100-None"`` / ``"None-5"`` junk string.
    """
    if range_min is not None and range_max is not None:
        return f"{range_min}–{range_max}"
    if range_min is not None:
        return f">= {range_min}"
    if range_max is not None:
        return f"<= {range_max}"
    return ""


def to_display_datetime(dt: datetime) -> str:
    base = dt.strftime("%b %d, %Y")
    if dt.hour != 0 or dt.minute != 0:
        base += dt.strftime(" at %H:%M")
    return base


def compact_date_label(dt: datetime) -> str:
    base = dt.strftime("%b %d")
    if dt.year != _current_year():
        base += dt.strftime(", %Y")
    if dt.hour != 0 or dt.minute != 0:
        base += dt.strftime(" %H:%M")
    return base


def flowsheet_date_header(dt: datetime) -> tuple[str, Optional[str]]:
    label = dt.strftime("%b %d")
    if dt.year != _current_year():
        label += dt.strftime(", %Y")
    sub = dt.strftime("%H:%M") if dt.hour != 0 or dt.minute != 0 else None
    return (label, sub)


def short_date_label(dt: datetime) -> str:
    return dt.strftime("%b %d")
