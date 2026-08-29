"""Building StandardizedBiomarker records from matched definitions, status
application, and the LLM-free fallback standardization."""

import logging
from typing import Optional

from mistralai import Mistral
from sqlalchemy.orm import Session

from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.schemas.ai import (
    RawBiomarker,
    RawMedicalRecord,
    StandardizedBiomarker,
    StandardizedMedicalRecord,
    StandardizedVisitData,
    TranslatedText,
)
from app.services import converters
from app.services.matcher._text import _is_ascii
from app.services.matcher.name_matching import canonicalize_gene_mutation_en
from app.services.matcher.translation import (
    _fallback_translate,
    _normalize_date,
    _normalize_time,
    _tx,
)
from app.services.matcher.units_conversion import (
    _apply_scale_function,
    _convert_to_canonical,
    convert_units,
)
from app.services.reference import (
    _ABSENT_CANONICAL,
    compute_status,
    merge_reference,
    normalize_qual,
    parse_reference,
    parse_value,
)

logger = logging.getLogger(__name__)


def _prefer_comma_pct(name: str) -> str:
    """Display convention: a fraction analyte reads "X, %" (comma before the
    percent sign), not "X %". Names already following the convention are left
    untouched. This only affects the *displayed* standardized name — the stored
    definition name keeps "X %" so fuzzy/index matching stays stable."""
    if name and name.endswith(" %") and not name.endswith(", %"):
        return name[:-2].rstrip() + ", %"
    return name


def _suppress_unit_for_qualitative(std_unit: str, defn: BiomarkerDefinitionModel, raw_unit: str) -> str:
    """Unit display rule for definitions without a usable canonical unit.

    A deliberately-unitless definition (``canonical_unit == ""``, anchored by
    a qualitative screen) has NO physical unit: never leak a raw unit column
    (e.g. a table-wide "lg копий/мл" header) or an invented reading-level
    guess onto its readings — regardless of the effective reference kind (an
    absent value against an unbounded interval note is still unitless).
    Legacy defs with no canonical at all keep their unit fallback unless the
    def itself is unitless AND the document carries no unit either (fix #9:
    don't invent "U/mL" for serology rows; a LOINC def whose ``unit`` is
    "%" keeps "%").
    """
    if defn.canonical_unit is not None and not (defn.canonical_unit or "").strip():
        return ""
    if (not (defn.canonical_unit or "").strip()
            and not (defn.unit or "").strip()
            and not (raw_unit or "").strip()):
        return ""
    return std_unit


def _build_standardized_from_def(
    raw_bm: RawBiomarker,
    defn: BiomarkerDefinitionModel,
    db: Optional[Session] = None,
    user_id: Optional[str] = None,
    client: Optional[Mistral] = None,
) -> StandardizedBiomarker:
    parsed_value = parse_value(raw_bm.value)

    # Canonicalize the document's own unit (e.g. Cyrillic "ммоль/л" -> "mmol/L").
    doc_unit = converters.normalize_unit(raw_bm.unit)
    doc_reference = parse_reference(raw_bm.raw_range_string)
    # Same boundless-note guard as the local path: an absent-canonical result
    # against "допустимо любое количество" is a qualitative screen — the
    # definition's own reference must decide the kind, not the leaked note.
    if (isinstance(doc_reference, dict) and doc_reference.get("kind") == "interval"
            and doc_reference.get("low") is None and doc_reference.get("high") is None
            and isinstance(parsed_value, str)
            and normalize_qual(parsed_value) in _ABSENT_CANONICAL):
        doc_reference = None

    # Document-first: when the lab printed its own reference range, trust it and
    # keep the value in the document's own (normalized) unit. This avoids lossy
    # unit conversion and compares like-for-like, preventing false out-of-range
    # flags (e.g. a glucose of 5.5 ммоль/л against the lab's own 3.9-6.1 range).
    # HOWEVER, when the definition has a canonical unit in a different *scale*
    # (e.g. log10 vs linear from a prior extraction), we MUST convert both the
    # value and the reference bounds to the canonical scale so readings from
    # different documents are numerically comparable.
    if doc_reference is not None:
        ref = merge_reference(doc_reference, defn.reference, parsed_value)
        if isinstance(parsed_value, str):
            canonical = normalize_qual(parsed_value)
            if ref.get("kind") == "interval" and canonical in _ABSENT_CANONICAL:
                parsed_value = 0.0
            else:
                parsed_value = canonical
        std_value = parsed_value
        std_unit = doc_unit or defn.unit
        scale_function: Optional[str] = None
        needs_review = False
        if isinstance(std_value, (int, float)) and not isinstance(std_value, bool):
            cv, cu, sf, nr = _convert_to_canonical(std_value, raw_bm, defn, client)
            if sf is not None:
                std_value = cv
                std_unit = cu
                scale_function = sf
                needs_review = nr
                if isinstance(ref, dict) and ref.get("kind") == "interval":
                    low = ref.get("low")
                    high = ref.get("high")
                    if low is not None:
                        cl = _apply_scale_function(float(low), sf)
                        if cl is not None:
                            ref["low"] = cl
                    if high is not None:
                        ch = _apply_scale_function(float(high), sf)
                        if ch is not None:
                            ref["high"] = ch
            elif (not nr and (cu or "").strip()
                  and cu == (defn.canonical_unit or "")
                  and cu != std_unit):
                # The reading's own unit translation equals the def's canonical
                # (no conversion needed), but the doc/def raw unit columns are
                # empty or generic — adopt the canonical. Covers dimensionless
                # "ratio" canonicals (a table-wide "lg копий/мл" header is
                # noise on a ratio row) and locally-unified rows whose def
                # anchored a real unit the document itself never printed.
                std_unit = cu
            elif nr:
                needs_review = True
        std_unit = _suppress_unit_for_qualitative(std_unit, defn, raw_bm.unit)
        return StandardizedBiomarker(
            raw_name=raw_bm.name,
            raw_value=raw_bm.value,
            raw_unit=raw_bm.unit,
            raw_range_string=raw_bm.raw_range_string,
            standard_name_en=_prefer_comma_pct(defn.names.get("en", raw_bm.name)),
            standard_value=std_value,
            standard_unit=std_unit,
            reference=ref,
            status=compute_status(std_value, ref) if isinstance(ref, dict) else "",
            category=defn.category,
            definition_id=defn.loinc_code or defn.id,
            scope=defn.scope,
            scale_function=scale_function,
            needs_review=needs_review,
            canonical_unit_inferred=defn.canonical_unit_inferred,
        )

    # No document range: fall back to the curated global reference, converting a
    # numeric value into the definition's canonical unit so the comparison is
    # valid. Qualitative values carry no unit so nothing to convert.
    scale_function = None
    needs_review = False
    if isinstance(parsed_value, (int, float)) and not isinstance(parsed_value, bool):
        std_value, std_unit, scale_function, needs_review = _convert_to_canonical(
            convert_units(
                parsed_value,
                raw_bm.unit,
                defn.unit,
                analyte_name=defn.names.get("en", raw_bm.name),
                loinc=defn.loinc_code,
                client=client,
            ),
            raw_bm,
            defn,
            client,
        )
    else:
        # Qualitative / non-numeric — still align the unit with the canonical
        # when there is one, so the display stays consistent.
        std_value, std_unit, scale_function, needs_review = _convert_to_canonical(
            parsed_value, raw_bm, defn, client,
        )

    ref = merge_reference(None, defn.reference, std_value)
    if isinstance(ref, dict) and ref.get("kind") == "qualitative":
        std_value = normalize_qual(std_value)
        # A qualitative screen with neither a printed unit nor a canonical one
        # has NO physical unit: don't let the reading-level unit guess invent
        # "U/mL" (serology rows printed as отрицат./Negative).
        std_unit = _suppress_unit_for_qualitative(std_unit, defn, raw_bm.unit)
    return StandardizedBiomarker(
        raw_name=raw_bm.name,
        raw_value=raw_bm.value,
        raw_unit=raw_bm.unit,
        raw_range_string=raw_bm.raw_range_string,
        standard_name_en=_prefer_comma_pct(defn.names.get("en", raw_bm.name)),
        standard_value=std_value,
        standard_unit=std_unit,
        reference=ref,
        status="",
        category=defn.category,
        definition_id=defn.loinc_code or defn.id,
        scope=defn.scope,
        scale_function=scale_function,
        needs_review=needs_review,
        canonical_unit_inferred=defn.canonical_unit_inferred,
    )


def _build_standardized_local(
    raw_bm: RawBiomarker,
    defn: BiomarkerDefinitionModel,
    client: Optional[Mistral] = None,
) -> StandardizedBiomarker:
    parsed_value = parse_value(raw_bm.value)
    parsed_ref = parse_reference(raw_bm.raw_range_string)
    # A boundless document note ("допустимо любое количество" — often a leaked
    # comment column) against an absent-canonical result ("не обнаруж") is a
    # QUALITATIVE screen, not a 0.0 measurement: the note carries no numeric
    # bound, so the definition's own reference must decide the kind.
    if (isinstance(parsed_ref, dict) and parsed_ref.get("kind") == "interval"
            and parsed_ref.get("low") is None and parsed_ref.get("high") is None
            and isinstance(parsed_value, str)
            and normalize_qual(parsed_value) in _ABSENT_CANONICAL):
        parsed_ref = None
    # A parsed interval ref means the document reported a numeric range, so
    # the biomarker is Quantitative. Keep the value type aligned with the ref:
    # numeric values stay as numbers, and a canonical "absent" result
    # ("не обнаружено" / "Negative" / "Absent" / "Normal") collapses to 0.0 so
    # it composes with the interval bounds in `compute_status`. Present results
    # against an interval ref have no known count and are kept as the raw
    # canonical string.
    if isinstance(parsed_ref, dict) and parsed_ref.get("kind") == "interval":
        if isinstance(parsed_value, str):
            canonical = normalize_qual(parsed_value)
            std_value = 0.0 if canonical in _ABSENT_CANONICAL else canonical
        else:
            std_value = parsed_value
    else:
        std_value = normalize_qual(parsed_value)

    # Cross-scale conversion: if the defn has a canonical unit (set on the
    # first reading that defined it) and the current reading's translated
    # unit differs, ask the LLM for the scale function (10^x, log10, …)
    # and apply it. Numeric values are converted; string values are kept raw
    # but flagged with `needs_review` so the UI can highlight the mismatch.
    std_value, std_unit, scale_function, needs_review = _convert_to_canonical(
        std_value, raw_bm, defn, client,
    )
    # When the scale was converted (e.g. log10 → linear), also convert the
    # document's reference bounds so the status computation compares values
    # and bounds in the same scale.
    if scale_function is not None and isinstance(parsed_ref, dict) and parsed_ref.get("kind") == "interval":
        low = parsed_ref.get("low")
        high = parsed_ref.get("high")
        if low is not None:
            cl = _apply_scale_function(float(low), scale_function)
            if cl is not None:
                parsed_ref["low"] = cl
        if high is not None:
            ch = _apply_scale_function(float(high), scale_function)
            if ch is not None:
                parsed_ref["high"] = ch

    # Prefer the translated English name; fall back to the original raw name if
    # the stored definition name is somehow still non-English (defense against
    # an untranslated local definition leaking the source language to the UI).
    en = defn.names.get("en") or raw_bm.standard_name_en or raw_bm.name
    if not _is_ascii(en):
        en = raw_bm.standard_name_en or raw_bm.name
    en = canonicalize_gene_mutation_en(en)

    ref = merge_reference(parsed_ref, defn.reference, std_value)
    # A qualitative screen with neither a printed unit nor a canonical one has
    # NO physical unit: don't let the reading-level unit guess invent "U/mL"
    # (serology rows printed as отрицат./Negative).
    std_unit = _suppress_unit_for_qualitative(std_unit, defn, raw_bm.unit)
    return StandardizedBiomarker(
        raw_name=raw_bm.name,
        raw_value=raw_bm.value,
        raw_unit=raw_bm.unit,
        raw_range_string=raw_bm.raw_range_string,
        standard_name_en=_prefer_comma_pct(en),
        standard_value=std_value,
        standard_unit=std_unit,
        reference=ref,
        status="",
        category=defn.category or raw_bm.category or "General",
        definition_id=defn.loinc_code or defn.id,
        scope=defn.scope,
        scale_function=scale_function,
        needs_review=needs_review,
        canonical_unit_inferred=bool(defn.canonical_unit_inferred) if hasattr(defn, "canonical_unit_inferred") else False,
    )


def _apply_status(result: StandardizedMedicalRecord) -> None:
    if not result.biomarkers:
        return
    for b in result.biomarkers:
        b.status = compute_status(b.standard_value, b.reference)


def _fallback_standardize(raw: RawMedicalRecord) -> StandardizedMedicalRecord:
    biomarkers: list[StandardizedBiomarker] = []
    if raw.biomarkers:
        for b in raw.biomarkers:
            parsed_value = parse_value(b.value)
            parsed_ref = parse_reference(b.raw_range_string)
            # Same Quantitative/Qualitative split as _build_standardized_local:
            # interval ref -> numeric value (canonical "absent" strings
            # collapse to 0.0 so value type matches the ref), qualitative ref
            # -> canonical string.
            if isinstance(parsed_ref, dict) and parsed_ref.get("kind") == "interval":
                if isinstance(parsed_value, str):
                    canonical = normalize_qual(parsed_value)
                    std_value = 0.0 if canonical in _ABSENT_CANONICAL else canonical
                else:
                    std_value = parsed_value
            else:
                std_value = normalize_qual(parsed_value)
            ref = merge_reference(parsed_ref, None, std_value)
            biomarkers.append(StandardizedBiomarker(
                raw_name=b.name,
                raw_value=b.value,
                raw_unit=b.unit,
                raw_range_string=b.raw_range_string,
                standard_name_en=b.name,
                standard_value=std_value,
                standard_unit=b.unit,
                reference=ref,
                status="",
                category=b.category or "General",
            ))

    visit_data = None
    if raw.visit_data:
        if hasattr(raw.visit_data, 'model_dump'):
            visit_data = _fallback_translate(raw.visit_data)
        else:
            visit_data = StandardizedVisitData(
                diagnosis=_tx(raw.visit_data.diagnosis if hasattr(raw.visit_data, 'diagnosis') else str(raw.visit_data)),
                chief_complaint=TranslatedText(),
                objective_findings=TranslatedText(),
                prescriptions=[],
                recommendations=[],
            )

    return StandardizedMedicalRecord(
        entry_type=raw.entry_type,
        date=_normalize_date(raw.date or ""),
        time=_normalize_time(raw.time or ""),
        clinic=raw.clinic,
        provider=raw.provider,
        title=raw.title,
        notes=raw.notes,
        biomarkers=biomarkers,
        visit_data=visit_data,
        instrumental_data=raw.instrumental_data,
    )
