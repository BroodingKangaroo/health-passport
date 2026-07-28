from typing import Annotated, Optional, Union

from pydantic import BaseModel, Field
from typing_extensions import Literal


class ReferenceInterval(BaseModel):
    """Numeric reference range. Either/both bounds may be null for one-sided
    ranges (e.g. ``{"low": null, "high": 5.0}`` models "< 5.0")."""

    kind: Literal["interval"] = "interval"
    low: Optional[float] = None
    high: Optional[float] = None


class ReferenceQualitative(BaseModel):
    """Non-numeric reference. ``expected`` is the normal/expected result text
    (e.g. "Negative") when the document prints one; null when the reference is
    merely "this is a qualitative test" with no expected value."""

    kind: Literal["qualitative"] = "qualitative"
    expected: Optional[str] = None


# A single structured reference. Its `kind` IS the result type — there is no
# separate result_type notion: an interval reference means a numeric result,
# a qualitative reference means a text result.
Reference = Annotated[
    Union[ReferenceInterval, ReferenceQualitative],
    Field(discriminator="kind"),
]