from datetime import datetime, timezone
from typing import Optional


def _current_year() -> int:
    return datetime.now(timezone.utc).year


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
