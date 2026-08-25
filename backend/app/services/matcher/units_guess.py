"""Unit translation to English + empty-unit guessing heuristics."""

import json
import logging
from typing import Optional

from mistralai import Mistral

from app.schemas.ai import RawBiomarker, UnitTranslationBatch
from app.services.matcher._cache import _local_cache, _unit_translation_cache
from app.services.matcher._text import _is_ascii

logger = logging.getLogger(__name__)

_UNIT_TRANSLATE_PROMPT = """You are a clinical-laboratory unit normaliser. For each unit string below, return the standard English form used in medical lab reports.

Rules:
- Items: one per line as `english analyte name | category | raw unit string`.
- Translate Russian / Belarusian / non-ASCII units into conventional English (e.g. "копий/мл" -> "copies/mL", "мг/дл" -> "mg/dL", "ммоль/л" -> "mmol/L", "г/л" -> "g/L").
- Preserve log-scale prefixes ("lg", "log", "ln") and translate only the magnitude part (e.g. "lg копий/мл" -> "lg copies/mL", "ln копий/мл" -> "ln copies/mL", "log10 копий/мл" -> "lg copies/mL").
- For an EMPTY raw unit string, invent a sensible unit based on the analyte name and category (e.g. stool microbiome panels without a unit cell usually mean "copies/mL" or "copies/g"). You MUST always return a non-empty `unit` for every item — never leave it blank.
- For already-English units, return them verbatim and set `inferred: false`.
- `kind` is "linear" by default, "log10" if the unit starts with "lg" / "log10" / "log" (case-insensitive), "ln" if the unit starts with "ln" (natural log).

Items (each line: english analyte name | category | raw unit):
{items}

Return a JSON object with a single key "translations" whose value is an array of objects, one per input in the same order. Each object has:
- unit: the standard English unit (MUST be non-empty even when the input unit is blank — invent one)
- kind: "linear" | "log10" | "ln"
- inferred: true if the unit was invented (no source unit), false otherwise"""


def _heuristic_unit_translation(
    raw_unit: str, analyte_name: str = "", category: str = ""
) -> Optional[dict]:
    """Cheap deterministic translation for units the parser can already
    recognise. Returns a UnitTranslation-shaped dict or None when the unit
    needs the LLM (e.g. Cyrillic / invented for empty)."""
    u = (raw_unit or "").strip()
    if not u:
        return None  # needs LLM to invent from analyte/category
    # The Cyrillic lowercase letters mean the LLM has to translate; skip.
    if not _is_ascii(u):
        return None
    low = u.lower()
    kind = "linear"
    if low.startswith(("lg", "log10", "log ")) or low == "log":
        kind = "log10"
    elif low.startswith("ln"):
        kind = "ln"
    return {"unit": u, "kind": kind, "inferred": False}


def _translated_unit(raw_unit: str, analyte_name: str = "", category: str = "") -> dict:
    """Return the cached translation for ``raw_unit``, or fall back to a
    heuristic identity translation (with kind inferred from the prefix).

    When the raw unit is empty and no LLM cache entry exists, the fallback is
    a best-effort guess based on ``analyte_name`` and ``category``.

    Never raises: an unrecognised unit always yields a usable dict.
    """
    u = (raw_unit or "").strip()
    cache = _local_cache(_unit_translation_cache)
    entry = cache.get(u)
    if entry is not None:
        return entry
    # Fall back when the batch translator never ran (e.g. LLM unavailable).
    if not u:
        return _guess_unit(analyte_name, category)
    low = u.lower()
    kind = "linear"
    if low.startswith(("lg", "log10", "log ")) or low == "log":
        kind = "log10"
    elif low.startswith("ln"):
        kind = "ln"
    return {"unit": u, "kind": kind, "inferred": False}


def _guess_unit(analyte_name: str, category: str) -> dict:
    """Best-effort fallback for an empty source unit when the LLM is
    unavailable or failed.  Returns a dict compatible with ``_translated_unit``
    shape with ``inferred: True``.

    Returns an empty unit for qualitative-only biomarkers (mutations,
    genetics) — those have no meaningful physical unit.
    """
    an = (analyte_name or "").lower()
    cat = (category or "").lower()

    # Genetics / mutations are qualitative — no unit.
    if "mutation" in an or "мутаци" in an or "gene" in an or "ген" in an:
        return {"unit": "", "kind": "linear", "inferred": False}
    if "genetic" in cat or "dna" in cat or "pcr" in cat:
        return {"unit": "", "kind": "linear", "inferred": False}

    # Ratio / dimensionless biomarkers — must come BEFORE the general category
    # checks so a microbiome "species X to species Y ratio" doesn't get
    # labelled "copies/mL".
    if ("ratio" in an or "соотношение" in an or "отношение" in an
            or "index" in an or "индекс" in an or "%" in an):
        return {"unit": "ratio", "kind": "linear", "inferred": True}

    # Microbiome / stool / bacterial panels → copies/mL (absolute PCR quant).
    if ("микробиот" in cat or "microbiota" in cat or "microbiome" in cat
            or "stool" in cat or "bacterial" in cat or "бактери" in cat
            or "bacter" in cat):
        return {"unit": "copies/mL", "kind": "linear", "inferred": True}

    # Common haematology / chemistry.
    if "esr" in an or "sedimentation" in an or "соэ" in an:
        return {"unit": "mm/hr", "kind": "linear", "inferred": True}
    if "wbc" in an or "leukocyte" in an or "white blood" in an or "лейкоцит" in an:
        return {"unit": "×10⁹/L", "kind": "linear", "inferred": True}
    if "rbc" in an or "erythrocyte" in an or "red blood" in an or "эритроцит" in an:
        return {"unit": "×10¹²/L", "kind": "linear", "inferred": True}
    if "hemoglobin" in an or "гемоглобин" in an or "hb" in an:
        return {"unit": "g/L", "kind": "linear", "inferred": True}
    if "hematocrit" in an or "гематокрит" in an or "hct" in an:
        return {"unit": "%", "kind": "linear", "inferred": True}
    if "platelet" in an or "тромбоцит" in an or "plt" in an:
        return {"unit": "×10⁹/L", "kind": "linear", "inferred": True}
    if "neutrophil" in an or "нейтрофил" in an or "neut" in an:
        return {"unit": "×10⁹/L", "kind": "linear", "inferred": True}
    if "lymphocyte" in an or "лимфоцит" in an or "lymph" in an:
        return {"unit": "×10⁹/L", "kind": "linear", "inferred": True}
    if "monocyte" in an or "моноцит" in an:
        return {"unit": "×10⁹/L", "kind": "linear", "inferred": True}
    if "eosinophil" in an or "эозинофил" in an:
        return {"unit": "×10⁹/L", "kind": "linear", "inferred": True}
    if "basophil" in an or "базофил" in an:
        return {"unit": "×10⁹/L", "kind": "linear", "inferred": True}
    if "creatinine" in an or "креатинин" in an:
        return {"unit": "μmol/L", "kind": "linear", "inferred": True}
    if "urea" in an or "мочевин" in an or "bun" in an:
        return {"unit": "mmol/L", "kind": "linear", "inferred": True}
    if "glucose" in an or "глюкоз" in an:
        return {"unit": "mmol/L", "kind": "linear", "inferred": True}
    if ("alt" in an or "alanine" in an or "аланин" in an or "алт" in an
            or "ast" in an or "aspartate" in an or "асат" in an or "аст" in an):
        return {"unit": "U/L", "kind": "linear", "inferred": True}
    if "bilirubin" in an or "билирубин" in an:
        return {"unit": "μmol/L", "kind": "linear", "inferred": True}
    if "cholesterol" in an or "холестерин" in an:
        return {"unit": "mmol/L", "kind": "linear", "inferred": True}
    if "triglyceride" in an or "триглицерид" in an:
        return {"unit": "mmol/L", "kind": "linear", "inferred": True}
    if "iron" in an or "железо" in an or "ferritin" in an or "ферритин" in an:
        return {"unit": "μmol/L", "kind": "linear", "inferred": True}
    if "vitamin" in an or "витамин" in an:
        return {"unit": "nmol/L", "kind": "linear", "inferred": True}
    if "tsh" in an or "thyroid" in an or "тиреотроп" in an or "ттг" in an:
        return {"unit": "mIU/L", "kind": "linear", "inferred": True}
    if "cortisol" in an or "кортизол" in an:
        return {"unit": "nmol/L", "kind": "linear", "inferred": True}
    if "virus" in cat or "viral" in an:
        return {"unit": "copies/mL", "kind": "linear", "inferred": True}
    if "hormone" in cat or "гормон" in cat:
        return {"unit": "pg/mL", "kind": "linear", "inferred": True}
    if "antibody" in cat or "igg" in an or "igm" in an:
        return {"unit": "U/mL", "kind": "linear", "inferred": True}
    if "enzyme" in cat or "activity" in an:
        return {"unit": "U/L", "kind": "linear", "inferred": True}

    # Broad fallback for molecular assays.
    return {"unit": "copies/mL", "kind": "linear", "inferred": True}


def _translate_units_batch(
    biomarkers: list[RawBiomarker],
    client: Mistral,
) -> dict[str, dict]:
    """Translate non-English / empty / ambiguous units to standard English
    via a single LLM call. Returns {raw_unit: {"unit", "kind", "inferred"}}.

    Already-English units with a recognised scale prefix are handled
    heuristically (no LLM call) so the helper is fast on the common case.
    """
    needed: dict[str, dict] = {}  # raw_unit -> {analyte, category}
    cache = _local_cache(_unit_translation_cache)
    for b in biomarkers:
        u = (b.unit or "").strip()
        # Empty units are handled per-biomarker by ``_guess_unit()`` later,
        # never by the batch LLM — otherwise all empty-unit biomarkers share
        # a single cache entry and the first extraction's guess (e.g. genetics
        # → empty) poisons subsequent extractions (e.g. microbiome → also empty).
        if not u:
            continue
        if u in cache:
            needed.pop(u, None)
            continue
        heur = _heuristic_unit_translation(u, b.name, b.category)
        if heur is not None:
            cache[u] = heur
            continue
        needed[u] = {"name": b.standard_name_en or b.name, "category": b.category}

    if not needed or client is None:
        return {}

    items = "\n".join(
        f'- {meta["name"] or "?"} | {meta["category"] or "General"} | {raw!r}'
        for raw, meta in needed.items()
    )
    system_prompt = _UNIT_TRANSLATE_PROMPT.format(items=items)
    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Return the JSON now."},
            ],
            response_format=UnitTranslationBatch,
            max_tokens=1000,
        )
    except Exception as e:
        logger.error("Unit translation LLM call failed: %s", e)
        return {}

    content = chat_response.choices[0].message.content
    try:
        if isinstance(content, str):
            parsed = UnitTranslationBatch(**json.loads(content))
        else:
            parsed = content
    except (json.JSONDecodeError, Exception) as e:
        logger.error("Failed to parse unit translation response: %s", e)
        return {}

    result: dict[str, dict] = {}
    cache = _local_cache(_unit_translation_cache)
    for g, (raw_unit, _meta) in zip(parsed.translations, needed.items()):
        unit = (g.unit or "").strip()
        inferred = bool(g.inferred)
        kind = (g.kind or "linear").strip().lower() or "linear"
        if kind not in ("linear", "log10", "ln"):
            kind = "linear"
        entry = {"unit": unit, "kind": kind, "inferred": inferred}
        cache[raw_unit] = entry
        result[raw_unit] = entry
    return result
