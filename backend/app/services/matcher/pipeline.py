"""The match_and_convert pipeline: orchestrates translation, matching,
verification, definition resolution and standardization."""

import logging

from mistralai import Mistral
from sqlalchemy.orm import Session

from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.db.seed_loinc import LOINC_NAME_OVERRIDES
from app.schemas.ai import (
    LoincGuess,
    RawBiomarker,
    RawMedicalRecord,
    StandardizedBiomarker,
    StandardizedMedicalRecord,
)
from app.services.matcher._cache import (
    _factor_cache,
    _scale_function_cache,
    _unit_translation_cache,
)
from app.services.matcher.definitions import _is_qualitative_result, verify_or_create
from app.services.matcher.llm_matching import (
    _common_biomarker_guide,
    _llm_zero_shot_batch,
    _verify_and_correct,
)
from app.services.matcher.loinc_store import (
    _load_loinc_aliases,
    _load_multilingual_lookup,
    _multilingual_code,
    _promote_loinc_from_csv,
)
from app.services.matcher.name_matching import (
    _fraction_variant,
    _is_percent_unit,
    build_local_name_index,
    build_name_index,
    deterministic_match,
    fuzzy_match,
    is_grounded,
    match_local_def,
)
from app.services.matcher.standardize import (
    _apply_status,
    _build_standardized_from_def,
    _build_standardized_local,
    _fallback_standardize,
)
from app.services.matcher.translation import (
    _llm_translate_visit_data,
    _normalize_date,
    _normalize_time,
    _translate_names_batch,
)
from app.services.matcher.units_guess import _translate_units_batch

logger = logging.getLogger(__name__)


def match_and_convert(
    raw: RawMedicalRecord,
    definitions: list[BiomarkerDefinitionModel],
    db: Session,
    user_id: str,
    client: Mistral,
) -> StandardizedMedicalRecord:
    # The LLM caches are thread-local, and matching runs on default-pool
    # executor threads that are reused for the process lifetime — so every
    # call must start from empty caches or the previous extraction's unit
    # translations / conversion factors leak into this one.
    _factor_cache.clear()
    _scale_function_cache.clear()
    _unit_translation_cache.clear()
    try:
        return _match_and_convert_impl(raw, definitions, db, user_id, client)
    except Exception as e:
        logger.error("match_and_convert failed: %s", e, exc_info=True)
        result = _fallback_standardize(raw)
        _apply_status(result)
        return result


def _match_and_convert_impl(
    raw: RawMedicalRecord,
    definitions: list[BiomarkerDefinitionModel],
    db: Session,
    user_id: str,
    client: Mistral,
) -> StandardizedMedicalRecord:
    std_biomarkers: list[StandardizedBiomarker] = []
    unmatched: list[RawBiomarker] = []
    matched_pairs: list[tuple[RawBiomarker, BiomarkerDefinitionModel]] = []
    # Biomarkers matched to the user's OWN local definitions (cross-document
    # unification of differently-worded locals). Trusted like curated matches:
    # the deterministic thresholds + measurement-kind gate already accepted
    # them, and an LLM rejection must not resurrect duplicate local defs.
    local_matched_ids: set[int] = set()

    index = build_name_index(definitions)
    local_index = build_local_name_index(definitions, user_id)
    biomarkers = list(raw.biomarkers or [])

    # Step 0: Translate non-English names to English so they can reuse the
    # English name index for exact/fuzzy/candidate matching.
    if biomarkers and client:
        _translate_names_batch(biomarkers, client)
        # Also translate units to a canonical English form. This is what
        # lets a later extraction with a different unit (e.g. `lg копий/мл`
        # vs. an empty cell) be converted into the same scale as the
        # first-seen canonical. Results are cached in
        # ``_unit_translation_cache`` for the duration of this call.
        _translate_units_batch(biomarkers, client)

    # Direct multilingual lookup (curated table) — resolves the most common
    # localized names deterministically without any LLM call.
    multilang = _load_multilingual_lookup()
    aliases = _load_loinc_aliases()
    # Biomarkers whose match came from the curated multilingual table. These are
    # treated as high-confidence and are excluded from the (non-deterministic)
    # LLM verification backstop so a loose LLM correction can never override a
    # hand-verified localized mapping.
    curated_ids: set[int] = set()
    # Biomarkers whose curated synonym marks them as local-only (no LOINC) and
    # which must therefore resolve to a per-user local definition, never to a
    # global LOINC guessed by the LLM zero-shot step.
    curated_local_ids: set[int] = set()
    # Sentinel code ("local-…") for each curated-local biomarker, so its local
    # definition can get a pinned panel category (see category_normalize).
    curated_local_codes: dict[int, str] = {}

    # Step 1: Resolve each biomarker in strict confidence order. Curated signals
    # (the multilingual table + the raw name's own attached synonyms) are the
    # most reliable, so they must win BEFORE any LLM-translation-based match — a
    # loose translation must never hijack a known localized name (e.g.
    # "Эритроциты" -> Erythrocytes, not a mistranslation that hits Potassium).
    for b in biomarkers:
        search_name = (b.standard_name_en or "").strip() or b.name
        extra = (b.name,) if b.name != search_name else ()

        # 1a. Curated multilingual table on the raw localized name.
        match = None
        code = _multilingual_code(b.name, multilang)
        if code:
            # A curated "local-" code marks an analyte that has NO standard
            # LOINC (e.g. "Activated lymphocytes") and is intentionally kept as
            # a per-user local definition. Skip any global LOINC lookup so it
            # can never be merged into a related global analyte (e.g. total
            # Lymphocytes), and let it resolve to a per-user local definition
            # in Step 2. Exclude it from the LLM verification backstop too.
            if code.startswith("local-"):
                unmatched.append(b)
                curated_ids.add(id(b))
                curated_local_ids.add(id(b))
                curated_local_codes[id(b)] = code
                continue
            # Redirect a curated code that was deduped away to its survivor.
            # Skip this when the code has an explicit display-name override —
            # that marks it as a real, distinct analyte (e.g. 13046-8 variant
            # lymphocytes) which must resolve to itself, not a dedupe survivor.
            if code not in LOINC_NAME_OVERRIDES:
                code = aliases.get(code, code)
            match = db.query(BiomarkerDefinitionModel).filter(
                BiomarkerDefinitionModel.loinc_code == code,
                BiomarkerDefinitionModel.scope == "global",
            ).first()
            # Promote a valid LOINC that exists in the full CSV but wasn't part
            # of the seeded subset (e.g. ESR, Hematocrit). Never fall back to a
            # local "shadow" definition that happens to carry the same LOINC —
            # that would resolve the analyte to a user-local def and surface it
            # as "Unrecognized" instead of the canonical global one.
            if match is None:
                match = _promote_loinc_from_csv(db, code)
            if match is not None:
                curated_ids.add(id(b))

        # 1b. Exact match on the raw name (hits its attached synonyms).
        if match is None:
            match = deterministic_match(b.name, index)

        # 1c. Exact match on the LLM-translated English name.
        if match is None and search_name != b.name:
            match = deterministic_match(search_name, index)

        # 1d. Fuzzy match (guarded) as a last non-LLM resort.
        if match is None:
            match = fuzzy_match(search_name, index, extra)

        # 1d2. Cross-document local unification: the same locally-defined
        # analyte worded differently by another lab («Соотношение X/Y» vs
        # «Отношение X и Y», "… ratio" vs "Ratio of … to …", «динамика»
        # suffixes). Exact (dynamics-stripped) first, then the guarded local
        # fuzzy rule. A match is only accepted when the measurement KIND is
        # compatible (a unitless qualitative screen never absorbs a numeric
        # row and vice versa) — otherwise leave unmatched so the row keeps
        # its own local definition exactly as before.
        if match is None and local_index:
            local = match_local_def(search_name, local_index, (b.name,) if b.name != search_name else ())
            if local is not None:
                def_unitless = not (local.canonical_unit or "").strip()
                row_qualitative = _is_qualitative_result(b)
                if def_unitless == row_qualitative:
                    match = local
                    local_matched_ids.add(id(b))

        # 1e. Unit-aware re-route: a percent result must land on the fraction
        # ("… %") variant of the analyte, not the absolute-count variant. The
        # document unit — not the LOINC property — decides, so "Эозинофилы, %"
        # (unit %) resolves to "Eosinophils %" and never to the absolute code.
        if match and _is_percent_unit(b.unit):
            frac = _fraction_variant(match, definitions)
            if frac is not None:
                match = frac

        if match:
            matched_pairs.append((b, match))
        else:
            unmatched.append(b)

    # Step 1.5: LLM verification backstop. Re-check each (raw name -> matched
    # analyte) pair; accept an LLM correction only when it re-validates against a
    # real global definition (grounded), otherwise send the biomarker back to the
    # unmatched pool so it can be resolved/localized instead of shown wrong.
    # Curated multilingual matches are trusted and skipped (see curated_ids).
    if matched_pairs and client:
        to_verify = [
            (b, m) for (b, m) in matched_pairs
            if id(b) not in curated_ids and id(b) not in local_matched_ids
        ]
        curated_kept = [
            (b, m) for (b, m) in matched_pairs
            if id(b) in curated_ids or id(b) in local_matched_ids
        ]
        # Skip the LLM entirely when nothing needs verification — an empty
        # batch would fire a wasted request (ISSUES.md #60).
        if to_verify:
            verified, rejected = _verify_and_correct(to_verify, index, db, client)
            matched_pairs = verified + curated_kept
            unmatched.extend(rejected)

    for b, match in matched_pairs:
        std_biomarkers.append(_build_standardized_from_def(b, match, db, user_id, client))

    # Step 2: LLM candidate-based guess for unmatched biomarkers
    if unmatched and client:
        common_map = _common_biomarker_guide(definitions)
        guesses = _llm_zero_shot_batch(unmatched, index, client, common_map)

        raw_to_guess: dict[str, LoincGuess] = {}
        for g in guesses:
            raw_to_guess[g.raw_name] = g

        for b in unmatched:
            guess = raw_to_guess.get(b.name)
            guessed_loinc = guess.guessed_loinc if guess else None

            # A curated local-only analyte (e.g. "Activated lymphocytes") must
            # never be promoted to a global LOINC the LLM happens to guess, even
            # if the guess looks grounded. Force it to a per-user local def via
            # force_local below — verify_or_create ignores grounded when
            # force_local is set, so no separate grounded flag is needed here.
            if id(b) in curated_local_ids:
                guessed_loinc = None

            # Was this guess grounded in a real (close) candidate? If not, keep
            # any promotion local so a blind guess can't corrupt global defs.
            search_name = (b.standard_name_en or "").strip() or b.name
            grounded = is_grounded(search_name, index)

            resolved = verify_or_create(
                db, b.name, guessed_loinc, user_id, raw_biomarker=b, grounded=grounded,
                force_local=id(b) in curated_local_ids,
                local_code=curated_local_codes.get(id(b)),
            )

            if resolved.scope == "global":
                std_biomarkers.append(_build_standardized_from_def(b, resolved, db, user_id, client))
            else:
                std_biomarkers.append(_build_standardized_local(b, resolved, client))
    elif unmatched:
        for b in unmatched:
            resolved = verify_or_create(db, b.name, None, user_id, raw_biomarker=b, grounded=False,
                                        force_local=id(b) in curated_local_ids,
                                        local_code=curated_local_codes.get(id(b)))
            std_biomarkers.append(_build_standardized_local(b, resolved, client))

    # Step 5: Visit data translation
    visit_data = None
    if raw.visit_data:
        visit_data = _llm_translate_visit_data(raw.visit_data, client)

    result = StandardizedMedicalRecord(
        entry_type=raw.entry_type,
        date=_normalize_date(raw.date or ""),
        time=_normalize_time(raw.time or ""),
        clinic=raw.clinic,
        provider=raw.provider,
        title=raw.title,
        notes=raw.notes,
        biomarkers=std_biomarkers,
        visit_data=visit_data,
        instrumental_data=raw.instrumental_data,
    )

    _apply_status(result)
    return result
