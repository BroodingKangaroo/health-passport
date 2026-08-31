"""LLM-assisted matching: candidate retrieval, zero-shot LOINC guessing and
the match-verification backstop."""

import json
import logging
from typing import Optional

from mistralai import Mistral
from rapidfuzz import fuzz, process
from sqlalchemy.orm import Session

from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.schemas.ai import (
    LoincGuess,
    LoincGuessBatch,
    MatchVerification,
    MatchVerificationBatch,
    RawBiomarker,
)
from app.services.matcher.loinc_store import _promote_loinc_from_csv
from app.services.matcher.name_matching import (
    _definition_rank,
    _normalize_name,
    deterministic_match,
    fuzzy_match,
)
from config import LLM_CALL_TIMEOUT_MS, MISTRAL_CHAT_MODEL

logger = logging.getLogger(__name__)

# Number of candidate definitions to offer the LLM per unmatched biomarker.
LLM_CANDIDATE_COUNT = 8

ZERO_SHOT_PROMPT = """You are a medical terminology assistant. For each raw biomarker extracted from a medical document, choose the single best matching LOINC code.

Each item lists the raw name and a set of candidate LOINC codes (code: English name) retrieved for it. Pick the candidate that best matches the analyte. If NONE of the candidates fit, set guessed_loinc to null.

Items:
{items}

Return a JSON array of objects, one per input name in the same order, each with:
- raw_name: the original name from the input (copy verbatim)
- standard_name_en: the standard English name of the analyte
- guessed_loinc: the chosen candidate LOINC code, or null if none fit"""


def _common_biomarker_guide(
    definitions: list[BiomarkerDefinitionModel], limit: int = 40
) -> list[str]:
    """Compact list of the most commonly ordered tests, for the LLM to use as a
    guide when no close candidate exists for an unmatched biomarker."""
    ranked = sorted(
        (d for d in definitions if d.scope == "global" and d.common_rank),
        key=lambda d: d.common_rank,
    )
    return [f'{d.loinc_code}: {d.names.get("en", d.id)}' for d in ranked[:limit]]


def _candidates_for(
    raw_name: str,
    index: dict[str, BiomarkerDefinitionModel],
    extra_names: tuple[str, ...] = (),
    limit: int = LLM_CANDIDATE_COUNT,
    score_cutoff: int = 60,
) -> list[BiomarkerDefinitionModel]:
    """Top-N candidate definitions (by fuzzy score) for the LLM to choose from.

    Candidates below `score_cutoff` are discarded so the LLM is never shown
    meaningless noise (e.g. a Cyrillic name vs. unrelated English tests)."""
    keys = list(index.keys())
    if not keys:
        return []
    seen: dict[str, BiomarkerDefinitionModel] = {}
    for candidate in (raw_name, *extra_names):
        key = _normalize_name(candidate or "")
        if not key:
            continue
        for match_key, _score, _idx in process.extract(
            key, keys, scorer=fuzz.WRatio, limit=limit, score_cutoff=score_cutoff
        ):
            defn = index[match_key]
            if defn.loinc_code and defn.loinc_code not in seen:
                seen[defn.loinc_code] = defn
    ranked = sorted(seen.values(), key=_definition_rank)
    return ranked[:limit]


_VERIFY_PROMPT = """You are a clinical laboratory expert auditing an automated biomarker matcher.
For each item you are given the ORIGINAL biomarker name as printed on the lab report (often non-English) and the analyte it was MATCHED to. Decide whether the match names the SAME clinical analyte.

Be strict about analytes that are commonly confused but distinct, e.g.:
- Erythrocytes (red blood cells) vs. Potassium vs. Nucleated erythrocytes (normoblasts)
- Total vs. Direct vs. Indirect bilirubin
- Absolute counts vs. percentages of the same cell type

Items:
{items}

Return a JSON object with key "verifications": an array with one object per input in the same order, each with:
- raw_name: the ORIGINAL name, copied verbatim
- agree: true if the match is the correct analyte, false otherwise
- corrected_name_en: when agree is false, the correct standard English analyte name (else "")
- corrected_loinc: when agree is false and you are confident, the correct LOINC code (else "")"""


def _verify_and_correct(
    matched_pairs: list[tuple[RawBiomarker, BiomarkerDefinitionModel]],
    index: dict[str, BiomarkerDefinitionModel],
    db: Session,
    client: Mistral,
) -> tuple[list[tuple[RawBiomarker, BiomarkerDefinitionModel]], list[RawBiomarker]]:
    """Audit each match with a single LLM call; correct or reject wrong ones.

    Returns ``(kept_pairs, rejected_raw)``. A disagreement is only overridden by
    an LLM correction that RE-VALIDATES against a real global definition
    (grounded); a correction that cannot be grounded causes the biomarker to be
    rejected back into the unmatched pool rather than shown incorrectly.
    """
    item_lines = "\n".join(
        f'- raw_name: "{b.name}" | matched_to: "{defn.names.get("en", defn.id)}"'
        f' (LOINC {defn.loinc_code})'
        for b, defn in matched_pairs
    )
    system_prompt = _VERIFY_PROMPT.format(items=item_lines)
    try:
        chat_response = client.chat.parse(
            timeout_ms=LLM_CALL_TIMEOUT_MS,
            model=MISTRAL_CHAT_MODEL,
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Return the JSON now."},
            ],
            response_format=MatchVerificationBatch,
            max_tokens=4000,
        )
    except Exception as e:
        logger.error("Match verification LLM call failed: %s", e)
        return matched_pairs, []

    content = chat_response.choices[0].message.content
    try:
        if isinstance(content, str):
            batch = MatchVerificationBatch(**json.loads(content))
        else:
            batch = content
    except (json.JSONDecodeError, Exception) as e:
        logger.error("Failed to parse verification response: %s", e)
        return matched_pairs, []

    by_raw: dict[str, MatchVerification] = {v.raw_name: v for v in batch.verifications}

    kept: list[tuple[RawBiomarker, BiomarkerDefinitionModel]] = []
    rejected: list[RawBiomarker] = []
    for b, defn in matched_pairs:
        v = by_raw.get(b.name)
        if v is None or v.agree:
            kept.append((b, defn))
            continue

        # Disagreement: try to ground the LLM's proposed correction.
        corrected = _resolve_correction(v, index, db)
        if corrected is not None and corrected.loinc_code != defn.loinc_code:
            logger.info(
                "Verifier corrected %r: %s -> %s",
                b.name, defn.loinc_code, corrected.loinc_code,
            )
            kept.append((b, corrected))
        else:
            logger.info(
                "Verifier rejected %r matched to %s (no grounded correction)",
                b.name, defn.loinc_code,
            )
            rejected.append(b)
    return kept, rejected


def _resolve_correction(
    v: MatchVerification,
    index: dict[str, BiomarkerDefinitionModel],
    db: Session,
) -> Optional[BiomarkerDefinitionModel]:
    """Ground an LLM correction to a real global definition, or return None."""
    if v.corrected_loinc:
        hit = db.query(BiomarkerDefinitionModel).filter(
            BiomarkerDefinitionModel.loinc_code == v.corrected_loinc,
            BiomarkerDefinitionModel.scope == "global",
        ).first()
        if hit is None:
            hit = _promote_loinc_from_csv(db, v.corrected_loinc)
        if hit is not None:
            return hit
    name = (v.corrected_name_en or "").strip()
    if name:
        return deterministic_match(name, index) or fuzzy_match(name, index)
    return None


def _llm_zero_shot_batch(
    unmatched: list[RawBiomarker],
    index: dict[str, BiomarkerDefinitionModel],
    client: Mistral,
    common_map: Optional[list[str]] = None,
) -> list[LoincGuess]:
    # Build a compact per-biomarker candidate list instead of dumping the
    # entire (5000+ entry) LOINC dictionary into the prompt.
    item_lines: list[str] = []
    for b in unmatched:
        extra = (b.standard_name_en,) if b.standard_name_en else ()
        candidates = _candidates_for(b.name, index, extra)
        if candidates:
            cand_str = "; ".join(
                f'{c.loinc_code}: {c.names.get("en", c.id)}' for c in candidates
            )
        elif common_map:
            # No close candidate: give the LLM a small guide of common tests so
            # it can still pick sensibly instead of guessing blindly.
            cand_str = "no close match; common tests: " + "; ".join(common_map[:25])
        else:
            cand_str = "(no candidates)"
        item_lines.append(f'- raw_name: "{b.name}" | candidates: {cand_str}')

    items = "\n".join(item_lines)
    system_prompt = ZERO_SHOT_PROMPT.format(items=items)

    try:
        chat_response = client.chat.parse(
            timeout_ms=LLM_CALL_TIMEOUT_MS,
            model=MISTRAL_CHAT_MODEL,
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Return the JSON array now."},
            ],
            response_format=LoincGuessBatch,
            max_tokens=4000,
        )
    except Exception as e:
        logger.error("Zero-shot LLM call failed: %s", e)
        return []

    content = chat_response.choices[0].message.content

    if isinstance(content, str):
        try:
            parsed = json.loads(content)
            batch = LoincGuessBatch(**parsed)
        except (json.JSONDecodeError, Exception) as e:
            logger.error("Failed to parse zero-shot response: %s", e)
            return []
    else:
        batch = content

    return batch.guesses


def _guess_is_consistent(
    defn: BiomarkerDefinitionModel,
    raw_biomarker: Optional[RawBiomarker],
) -> bool:
    """Sanity-check an LLM LOINC guess against the biomarker's English name.

    Prevents blatantly wrong promotions (e.g. Bilirubin -> Calcium): the guessed
    definition's English name must fuzzily agree with the extracted English
    analyte name. When no English name is available we can't validate, so we
    accept (the caller only reaches here for grounded guesses).
    """
    en = (raw_biomarker.standard_name_en or "").strip() if raw_biomarker else ""
    if not en:
        return True
    def_name = defn.names.get("en", "") or ""
    names = [def_name, *list(defn.synonyms or [])]
    best = max(
        (fuzz.WRatio(_normalize_name(en), _normalize_name(n)) for n in names if n),
        default=0,
    )
    return best >= 70
