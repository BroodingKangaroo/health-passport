"""Biomarker definition resolution/persistence: verify_or_create and local
definition copies. This is where first-seen canonical units get anchored."""

import hashlib
import re
from typing import Optional, Union

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.schemas.ai import RawBiomarker
from app.services.category_normalize import normalize_category
from app.services.matcher._text import _is_ascii
from app.services.matcher.llm_matching import _guess_is_consistent
from app.services.matcher.loinc_store import _promote_loinc_from_csv
from app.services.matcher.name_matching import (
    _is_fraction_def,
    _normalize_name,
    _strip_trailing_punct,
    canonicalize_gene_mutation_en,
)
from app.services.matcher.units_conversion import _apply_scale_function
from app.services.matcher.units_guess import (
    _cyrillic_magnitude_en,
    _is_ratio_name,
    _translated_unit,
)
from app.services.reference import merge_reference, parse_reference, parse_value

_LOG_PREFIX_RE = re.compile(r"^(log10|log|lg|ln)\s*", re.IGNORECASE)


def _linearized_anchor(translation: dict, *names: str) -> tuple[dict, Optional[str]]:
    """First-seen anchoring never lands on a log-scale canonical unit.

    A raw unit like ``lg копий/мл`` translates to ``lg copies/mL``
    (kind ``log10``); the def's canonical unit is the linear magnitude
    (``copies/mL``) and readings printed in the log unit convert via the
    deterministic ``10^x`` scale function at read time. ``ln``-prefixed
    units linearize the same way (``exp(x)``). Ratio-like analytes are
    dimensionless — a log prefix there is a table-header artifact — so the
    canonical is ``ratio`` and nothing is scaled.

    Returns ``(translation, scale_function)`` where ``scale_function`` is the
    conversion that must ALSO be applied to the anchoring document's own
    value/reference (``None`` when nothing was rescaled). The returned dict is
    a new object whenever linearization applies; the input is never mutated.
    """
    unit = (translation.get("unit") or "").strip()
    kind = (translation.get("kind") or "linear").strip().lower()
    if not unit or kind not in ("log10", "ln"):
        return translation, None
    if _is_ratio_name(*names):
        return {"unit": "ratio", "kind": "linear", "inferred": True}, None
    m = _LOG_PREFIX_RE.match(unit)
    stripped = unit[m.end():].strip() if m else unit
    if not stripped or stripped == unit:
        # Log kind without a recognisable textual prefix (or nothing left
        # after stripping) — leave the translation untouched.
        return translation, None
    if not _is_ascii(stripped):
        # Offline path (client=None): the unit translation is an identity of
        # the Cyrillic raw string — map the magnitude part deterministically.
        stripped = _cyrillic_magnitude_en(stripped)
        if not stripped:
            return {"unit": "", "kind": "linear", "inferred": False}, (
                "10^x" if kind == "log10" else "exp(x)"
            )
    return (
        {
            "unit": stripped,
            "kind": "linear",
            "inferred": bool(translation.get("inferred")),
        },
        "10^x" if kind == "log10" else "exp(x)",
    )


def _anchor_translation(
    raw_unit: str, en_name: str, raw_name: str, category: str
) -> tuple[dict, Optional[str]]:
    """Decide a definition's first-seen canonical anchor.

    Ratio-like analytes are dimensionless: the ratio anchor is forced BEFORE
    any unit translation, so a concentration unit leaking from the table
    (e.g. a 'мг/дл' column header on a ratio row) never becomes the
    canonical — the ``_convert_to_canonical`` ratio pass-through would never
    fire for a concentration canonical (ISSUES.md #46). Otherwise translate
    the raw unit and linearize log-scale anchors (see ``_linearized_anchor``).

    Returns ``(translation, scale_function)`` like ``_linearized_anchor``.
    """
    if _is_ratio_name(en_name, raw_name):
        return {"unit": "ratio", "kind": "linear", "inferred": True}, None
    return _linearized_anchor(
        _translated_unit(raw_unit, en_name, category), en_name, raw_name
    )


def _rescale_reference(ref: Optional[dict], scale_function: str) -> Optional[dict]:
    """Apply a scale function to an interval reference's numeric bounds
    (used when a definition is anchored from a log-scale document)."""
    if not isinstance(ref, dict) or ref.get("kind") != "interval":
        return ref
    out = dict(ref)
    for key in ("low", "high"):
        v = out.get(key)
        if v is not None:
            sv = _apply_scale_function(float(v), scale_function)
            if sv is not None:
                out[key] = sv
    return out


def _rescale_value(value: Union[float, str, None], scale_function: str):
    """Apply a scale function to a parsed numeric value (strings pass through)."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        sv = _apply_scale_function(float(value), scale_function)
        return value if sv is None else sv
    return value


def _is_qualitative_result(raw_biomarker: Optional[RawBiomarker]) -> bool:
    """True when the reading's value/range carry no numeric content at all
    (e.g. ``отрицат.``, ``не выявлена``): the test is a qualitative screen and
    has no meaningful canonical concentration unit, so first-seen anchoring
    must NOT invent one."""
    if raw_biomarker is None:
        return False
    text = f"{raw_biomarker.value or ''} {raw_biomarker.raw_range_string or ''}"
    return bool(text.strip()) and not any(ch.isdigit() for ch in text)


def verify_or_create(
    db: Session,
    raw_name: str,
    guessed_loinc: Optional[str],
    user_id: str,
    raw_biomarker: Optional[RawBiomarker] = None,
    grounded: bool = True,
    force_local: bool = False,
    local_code: Optional[str] = None,
) -> BiomarkerDefinitionModel:
    # Only trust an LLM LOINC guess when it was grounded in real candidates AND
    # is consistent with the analyte's English name. Ungrounded / inconsistent
    # guesses must never touch the shared global dictionary — they fall through
    # to a user-local definition (fixes the "Билирубин -> Calcium" bug).
    if guessed_loinc and grounded and not force_local:
        existing = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.loinc_code == guessed_loinc,
            BiomarkerDefinitionModel.scope == "global",
        ).first()
        if existing is None:
            existing = _promote_loinc_from_csv(db, guessed_loinc)
        if existing is not None and _guess_is_consistent(existing, raw_biomarker):
            # Never fold a raw name onto a percent/fraction definition as a
            # synonym — that is how absolute ("… абс.") readings got merged into
            # the "%" analyte. Other (non-fraction) definitions keep learning
            # synonyms for matching recall.
            if not _is_fraction_def(existing):
                syns = list(existing.synonyms or [])
                raw_lower = raw_name.lower()
                if raw_lower not in (s.lower() for s in syns):
                    syns.append(raw_name)
                    existing.synonyms = syns
                    db.flush()
            return existing
        # Not consistent or couldn't resolve — fall through to local.

    # Fallback: match by name or synonym against global definitions. Curated
    # forced-local analytes skip this scan: a previously LEARNED global synonym
    # (e.g. 'anti-Opisthorchis IgG' once attached to the bare IgG def) must
    # never resurrect a mapping that curation deliberately sends to a local def.
    if not force_local:
        raw_norm = _normalize_name(raw_name)
        for defn in db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.scope == "global"
        ).all():
            for n in defn.names.values():
                if n and _normalize_name(n) == raw_norm:
                    if not _is_fraction_def(defn):
                        syns = list(defn.synonyms or [])
                        if raw_name.lower() not in (s.lower() for s in syns):
                            syns.append(raw_name)
                            defn.synonyms = syns
                            db.flush()
                    return defn
            for syn in (defn.synonyms or []):
                if syn and _normalize_name(syn) == raw_norm:
                    if not _is_fraction_def(defn):
                        syns = list(defn.synonyms or [])
                        if raw_name.lower() not in (s.lower() for s in syns):
                            syns.append(raw_name)
                            defn.synonyms = syns
                            db.flush()
                    return defn

    # Use the normalized name (trailing punctuation stripped + lowercased) for
    # the def id so that cosmetic variants like "Bifidobacterium spp" and
    # "Bifidobacterium spp." (period present or missing in the OCR) collapse to
    # the same local definition instead of creating duplicates. The original
    # raw name is still stored as a synonym so future exact-match by the raw
    # form still works.
    canonical_name = _normalize_name(raw_name)
    # Per-user id (same scheme as the manual-entry path in entries.py): two
    # users extracting the same novel analyte must get isolated definitions,
    # never collide on a shared primary key.
    defn_id = f"local-{user_id}-{hashlib.md5(canonical_name.encode()).hexdigest()[:12]}"

    # Early existence check: within one uncommitted session (offline validators,
    # batch tools) a definition created for an earlier document is still PENDING
    # — re-inserting the same id would raise UNIQUE-violation, and recovering
    # after db.rollback() is impossible because rollback discards that very
    # object. Ownership-filtered so a def is only ever reused by its owner.
    # Check-before-insert behavior.
    existing_local = db.query(BiomarkerDefinitionModel).filter(
        BiomarkerDefinitionModel.id == defn_id,
        BiomarkerDefinitionModel.user_id == user_id,
    ).first()
    if existing_local is not None:
        return existing_local

    # Use the translated English name as the canonical "en" name when
    # available; only strip OCR-attached trailing punctuation so the
    # human-readable casing is preserved.
    en_name = raw_name
    if raw_biomarker and raw_biomarker.standard_name_en and _is_ascii(
        raw_biomarker.standard_name_en
    ):
        en_name = canonicalize_gene_mutation_en(
            _strip_trailing_punct(raw_biomarker.standard_name_en.strip())
        )
    syns = [raw_name]
    if en_name and en_name != raw_name and en_name not in syns:
        syns.append(en_name)

    # Parse reference from raw biomarker if available; a non-numeric value forces
    # a qualitative reference.
    reference = None
    unit = ""
    # Canonical (English) unit + scale kind, used as the conversion target
    # for any later reading of the same biomarker. Set on the first reading
    # that creates the def, so e.g. a 25.06 row with an empty unit cell
    # anchors the canonical to whatever the LLM invents (typically
    # "copies/mL"); a 13.05 row with "lg копий/мл" linearizes the same way —
    # the canonical lands on the LINEAR magnitude and the log-scale row
    # converts into it via the deterministic ``10^x`` scale function
    # (see ``_linearized_anchor``).
    canonical_unit: Optional[str] = None
    canonical_kind = "linear"
    canonical_unit_inferred = False
    if raw_biomarker:
        doc_ref = parse_reference(raw_biomarker.raw_range_string)
        parsed_val = parse_value(raw_biomarker.value)
        if _is_qualitative_result(raw_biomarker):
            # Qualitative screen (text-only result): no physical unit exists.
            # Force the canonical empty instead of letting _guess_unit / the
            # batch LLM translator invent "U/mL" for a serology row.
            canonical_unit = ""
            canonical_kind = "linear"
            canonical_unit_inferred = False
        else:
            translation, anchor_sf = _anchor_translation(
                raw_biomarker.unit, en_name, raw_name, raw_biomarker.category
            )
            canonical_unit = translation["unit"]
            canonical_kind = translation["kind"]
            canonical_unit_inferred = bool(translation["inferred"])
            if anchor_sf:
                # The anchoring document printed its range/value in the log
                # scale; the def's stored reference must live in the linear
                # canonical scale so later readings (and the def UI) compare
                # like-for-like.
                doc_ref = _rescale_reference(doc_ref, anchor_sf)
                parsed_val = _rescale_value(parsed_val, anchor_sf)
        reference = merge_reference(doc_ref, None, parsed_val)
        unit = raw_biomarker.unit

    new_defn = BiomarkerDefinitionModel(
        id=defn_id,
        names={"en": en_name},
        synonyms=syns,
        category=normalize_category(
            raw_biomarker.category if raw_biomarker else "General",
            loinc_code=local_code,
        ),
        reference=reference,
        unit=unit,
        scope="local",
        user_id=user_id,
        reference_source="pdf_extracted",
        canonical_unit=canonical_unit,
        canonical_kind=canonical_kind,
        canonical_unit_inferred=canonical_unit_inferred,
    )
    # The INSERT runs inside a SAVEPOINT: a concurrent-insert IntegrityError
    # must only discard this definition, not the earlier uncommitted
    # definitions of the same batch (a session-wide rollback would expunge
    # them and the final commit would persist readings pointing at defs that
    # no longer exist — ISSUES.md #40). The def is added INSIDE the savepoint
    # so a rollback expunges it instead of leaving a zombie pending row.
    nested = db.begin_nested()
    db.add(new_defn)
    try:
        db.flush()
    except IntegrityError:
        nested.rollback()
        existing = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.id == defn_id,
            BiomarkerDefinitionModel.user_id == user_id,
        ).first()
        if existing:
            return existing
        raise
    else:
        nested.commit()
    return new_defn
