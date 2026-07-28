from datetime import datetime, timezone
from typing import Any, Optional, Union

from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.db.models import BiomarkerReading


def _current_year() -> int:
    return datetime.now(timezone.utc).year


def reading_value(reading: BiomarkerReading) -> Union[float, str, None]:
    """Merge a reading's numeric and text columns into the single union value
    exposed on the wire. Numeric wins; qualitative results fall back to text."""
    if reading.value is not None:
        return reading.value
    return reading.value_text


def effective_reference(reading: Optional[BiomarkerReading], defn: BiomarkerDefinitionModel) -> Any:
    """The reference used to interpret a reading: the reading's own snapshot
    (document's own if the lab printed one) else the definition's reference."""
    if reading is not None and reading.reference is not None:
        return reading.reference
    return defn.reference


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
