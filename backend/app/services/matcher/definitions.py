"""Biomarker definition resolution/persistence: verify_or_create and local
definition copies. This is where first-seen canonical units get anchored."""

import hashlib
from typing import Optional

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
)
from app.services.matcher.units_guess import _translated_unit
from app.services.reference import merge_reference, parse_reference, parse_value


def verify_or_create(
    db: Session,
    raw_name: str,
    guessed_loinc: Optional[str],
    user_id: str,
    raw_biomarker: Optional[RawBiomarker] = None,
    grounded: bool = True,
) -> BiomarkerDefinitionModel:
    # Only trust an LLM LOINC guess when it was grounded in real candidates AND
    # is consistent with the analyte's English name. Ungrounded / inconsistent
    # guesses must never touch the shared global dictionary — they fall through
    # to a user-local definition (fixes the "Билирубин -> Calcium" bug).
    if guessed_loinc and grounded:
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

    # Fallback: match by name or synonym against global definitions
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
    defn_id = f"local-{hashlib.md5(canonical_name.encode()).hexdigest()[:12]}"

    # Use the translated English name as the canonical "en" name when
    # available; only strip OCR-attached trailing punctuation so the
    # human-readable casing is preserved.
    en_name = raw_name
    if raw_biomarker and raw_biomarker.standard_name_en and _is_ascii(
        raw_biomarker.standard_name_en
    ):
        en_name = _strip_trailing_punct(raw_biomarker.standard_name_en.strip())
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
    # "copies/mL"); a 13.05 row with "lg копий/мл" is then converted into
    # that canonical via ``_llm_scale_function``.
    canonical_unit: Optional[str] = None
    canonical_kind = "linear"
    canonical_unit_inferred = False
    if raw_biomarker:
        doc_ref = parse_reference(raw_biomarker.raw_range_string)
        parsed_val = parse_value(raw_biomarker.value)
        reference = merge_reference(doc_ref, None, parsed_val)
        unit = raw_biomarker.unit
        translation = _translated_unit(raw_biomarker.unit, en_name, raw_biomarker.category)
        canonical_unit = translation["unit"]
        canonical_kind = translation["kind"]
        canonical_unit_inferred = bool(translation["inferred"])

    new_defn = BiomarkerDefinitionModel(
        id=defn_id,
        names={"en": en_name},
        synonyms=syns,
        category=normalize_category(
            raw_biomarker.category if raw_biomarker else "General"
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
    db.add(new_defn)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.id == defn_id
        ).first()
        if existing:
            return existing
        raise
    return new_defn


def _make_local_copy(
    db: Session,
    user_id: str,
    source: Optional[BiomarkerDefinitionModel],
    raw_biomarker: RawBiomarker,
) -> BiomarkerDefinitionModel:
    """Create a user-local definition for an ungrounded guess.

    Copies metadata from a global `source` when available (so the user still
    gets units/ranges), but keeps it in `scope='local'` so a wrong LLM guess
    never pollutes the shared global dictionary.
    """
    # Use the normalized name (trailing punctuation stripped) for the def id
    # so cosmetic variants collapse to the same local definition. See
    # ``verify_or_create`` for the full rationale.
    canonical_name = _normalize_name(raw_biomarker.name)
    defn_id = f"local-{hashlib.md5(canonical_name.encode()).hexdigest()[:12]}"
    existing = db.query(BiomarkerDefinitionModel).filter(
        BiomarkerDefinitionModel.id == defn_id
    ).first()
    if existing:
        return existing

    if source is not None:
        names = dict(source.names or {"en": raw_biomarker.name})
        synonyms = list(source.synonyms or [])
        unit = source.unit or ""
        category = normalize_category(
            source.category or (raw_biomarker.category or "General"),
            loinc_code=source.loinc_code if source else None,
        )
    else:
        # Prefer the translated English name as the canonical "en" name; keep
        # the original source-language name as a synonym for future matching.
        # Only strip OCR-attached trailing punctuation so the human-readable
        # casing is preserved.
        en_name = raw_biomarker.name
        if raw_biomarker.standard_name_en and _is_ascii(
            raw_biomarker.standard_name_en
        ):
            en_name = _strip_trailing_punct(raw_biomarker.standard_name_en.strip())
        names = {"en": en_name}
        synonyms = [raw_biomarker.name]
        if en_name and en_name != raw_biomarker.name and en_name not in synonyms:
            synonyms.append(en_name)
        unit = raw_biomarker.unit or ""
        category = normalize_category(raw_biomarker.category or "General")

    if raw_biomarker.name not in synonyms:
        synonyms.append(raw_biomarker.name)

    doc_ref = parse_reference(raw_biomarker.raw_range_string)
    parsed_val = parse_value(raw_biomarker.value)
    source_ref = source.reference if source is not None else None
    reference = merge_reference(doc_ref, source_ref, parsed_val)

    # Canonical (English) unit on first sight — anchors the conversion for
    # any later reading of the same biomarker. See ``verify_or_create`` for
    # the matching rationale.
    translation = _translated_unit(raw_biomarker.unit, en_name, category)
    canonical_unit = translation["unit"] or raw_biomarker.unit
    canonical_kind = translation["kind"]
    canonical_unit_inferred = bool(translation["inferred"])

    local = BiomarkerDefinitionModel(
        id=defn_id,
        names=names,
        synonyms=synonyms,
        category=category,
        reference=reference,
        unit=unit,
        scope="local",
        user_id=user_id,
        reference_source=source.reference_source if source is not None else "pdf_extracted",
        canonical_unit=canonical_unit,
        canonical_kind=canonical_kind,
        canonical_unit_inferred=canonical_unit_inferred,
    )
    db.add(local)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.id == defn_id
        ).first()
        if existing:
            return existing
        raise
    return local
