"""Deterministic and fuzzy name matching against the definition name index."""

import re
import unicodedata
from typing import Optional

from rapidfuzz import fuzz, process

from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.services import converters

# Fuzzy-match acceptance threshold (0-100). Above this we accept a match
# without consulting the LLM.
FUZZY_ACCEPT_SCORE = 90
# In addition to the WRatio cutoff, a fuzzy candidate must reach this
# length-sensitive Levenshtein ratio. This blocks cross-analyte partial matches
# (e.g. "Erythrocyte sedimentation rate" -> "Erythrocyte", "ESR" -> "SR") that
# WRatio/token_set_ratio score deceptively high on shared substrings/subset
# tokens, while still allowing genuine qualifier matches like
# "Total bilirubin" -> "Bilirubin" or "Glucose fasting" -> "Glucose".
FUZZY_RATIO_MIN = 55
# Reject fuzzy hits on ultra-short index keys (2-char abbreviations) unless the
# query matches them exactly — they are too ambiguous to match fuzzily.
MIN_FUZZY_KEY_LEN = 3

# LOCAL-definition unification (cross-document "same analyte, different
# wording"): one lab writes «Соотношение Bacteroides spp./ F. prausnitzii»,
# another «Отношение Bacteroides spp и F. prausnitzii» or the LLM translates
# them as "… ratio" / "Ratio of … to …". The strict global thresholds (WRatio
# >= 90) miss the legitimate word-order variants, while plainly lowering the
# cutoff would merge "Shigella spp" into "Salmonella spp". The local rule
# therefore lowers WRatio but adds a token-subset guard: a query whose tokens
# are a strict SUBSET of the candidate's (candidate has extra defining tokens,
# e.g. "Escherichia coli" vs "Escherichia coli enteropathogenic") never
# merges, while a query that merely ADDS qualifier/noise words
# ("Ratio of … Dynamics") does.
LOCAL_FUZZY_ACCEPT_SCORE = 78

# "Dynamics" qualifiers («динамика», «Dynamics», «(динамика)») are column/
# report-section noise, not analyte-defining words: strip them before local
# matching so "Lactobacillus spp (Динамика)" unifies with "Lactobacillus spp".
_DYNAMICS_TOKEN_RE = re.compile(
    r"(?i)(?:[,;(]?\s*(?:динамика|dynamics)\s*[;)]?)\s*|\s+(?:динамика|dynamics)\s*$"
)


def _strip_dynamics_tokens(name: str) -> str:
    """Remove dynamics qualifiers and collapse whitespace (local matching only;
    def-id hashing keeps the original form)."""
    out = _DYNAMICS_TOKEN_RE.sub(" ", name or "")
    return " ".join(out.split()).strip()


def _token_set(key: str) -> frozenset:
    return frozenset(t for t in re.split(r"[^a-zа-я0-9]+", key) if t)


def _is_query_subset_of_candidate(query_key: str, candidate_key: str) -> bool:
    """True when the query's meaningful tokens are a STRICT subset of the
    candidate's — the candidate names a MORE specific analyte and merging
    would fold a generic/shorter name onto it (Escherichia coli ->
    Escherichia coli enteropathogenic)."""
    q, c = _token_set(query_key), _token_set(candidate_key)
    return bool(q) and q < c

# Unit tokens that denote a percentage / fraction-of-100 measurement, as opposed
# to an absolute count. Used to route percent results to the fraction ("… %")
# LOINC variant rather than the absolute-count variant.
_PERCENT_UNITS = {"%", "percent", "pct", "10*2/%", "10*2/100", "%/100", "pc"}

# Tokens that merely name an immunoglobulin CLASS. A definition whose whole
# name is one of these ("IgG", "IgA", …) is a generic mass-concentration
# analyte; a compound query like "anti-Toxocara IgG" or "Корь IgM" names a
# DIFFERENT organism/virus-specific antibody screen and must never land on
# the bare class via fuzzy match (it conflates distinct analytes).
_CARRIER_TOKENS = frozenset({"igg", "iga", "igm", "ige", "ig", "immunoglobulin"})
# Connector words that don't distinguish a compound antibody query.
_CARRIER_CONNECTORS = frozenset({"anti", "antibody", "antibodies", "антитела"})


def _is_carrier_subset_collision(query_key: str, matched_key: str) -> bool:
    """True when ``matched_key`` consists ONLY of immunoglobulin-class tokens
    while ``query_key`` carries additional meaningful words — i.e. a specific
    anti-<target> screen about to be folded onto the bare immunoglobulin def."""
    tokens = re.split(r"[^a-zа-я0-9]+", matched_key)
    if not tokens or any(t not in _CARRIER_TOKENS for t in tokens):
        return False
    extra = [
        t
        for t in re.split(r"[^a-zа-я0-9]+", query_key)
        if len(t) >= 5
        and not t.isdigit()
        and t not in _CARRIER_TOKENS
        and t not in _CARRIER_CONNECTORS
    ]
    return bool(extra)


def _is_percent_unit(unit: Optional[str]) -> bool:
    """True when the raw document unit expresses a percentage (not an absolute count)."""
    if not unit:
        return False
    norm = converters.normalize_unit(unit)
    token = norm.strip().lower()
    if token in _PERCENT_UNITS:
        return True
    # Also catch trailing "%" after a number-like or ratio token, e.g. "1/100".
    return token.endswith("%") or token.endswith("/100")


# Punctuation commonly attached to biomarker names by OCR
_PUNCT_RE = re.compile(r'[,:;.()\[\]{}"\'\-–—/\\|#@!?]\s*$')


def _strip_trailing_punct(name: str) -> str:
    """Strip OCR-attached trailing punctuation and normalise unicode. Case is preserved."""
    name = unicodedata.normalize('NFKC', name)
    return _PUNCT_RE.sub('', name.strip())


def _normalize_name(name: str) -> str:
    """Normalize a biomarker name by stripping punctuation, normalising unicode,
    and lowercasing. Used for case-insensitive matching / hashing / lookup."""
    return _strip_trailing_punct(name).lower()


# The batch translator flips between two word orders for gene-mutation
# parentheses across calls — "(9 exon" vs "(exon 9" (observed bimodally on
# рнпц_омр_генетика, 5 consecutive runs one way then flipping back inside one
# benchmark). Canonicalize deterministically so the stored/displayed English
# definition name never flaps: always the "exon N" order.
_MUTATION_ORDER_RE = re.compile(r"\((\d+)\s+(exon)\b", re.IGNORECASE)


def canonicalize_gene_mutation_en(name: str) -> str:
    """Rewrite "(N exon" -> "(exon N" in an English mutation display name.

    Idempotent; everything after the swapped token (e.g. "; V617F") is kept
    verbatim. Non-mutation names pass through untouched."""
    if not name:
        return name
    return _MUTATION_ORDER_RE.sub(lambda m: f"(exon {m.group(1)}", name)


def _definition_rank(defn: BiomarkerDefinitionModel) -> int:
    """Preference key (lower = better). Uses LOINC COMMON_TEST_RANK so the most
    commonly ordered test wins when several definitions share a synonym."""
    rank = defn.common_rank
    return rank if rank is not None else 10**9


def build_name_index(
    definitions: list[BiomarkerDefinitionModel],
) -> dict[str, BiomarkerDefinitionModel]:
    """Map normalized name/synonym -> global definition for O(1) lookup.

    Definitions are ranked so blood/serum concentration tests win collisions
    over urine/stool/ratio variants that share generic synonyms.
    """
    index: dict[str, BiomarkerDefinitionModel] = {}
    # Global definitions are the primary, shared dictionary. System-shared local
    # definitions (user_id IS NULL, e.g. curated local-only analytes like
    # "Activated lymphocytes") are also matchable so they aren't silently lost
    # to a fuzzy global match — but global wins any name collision.
    ranked = sorted(
        (d for d in definitions if d.scope == "global"),
        key=_definition_rank,
    )
    for d in ranked:
        for s in list(d.names.values()) + (d.synonyms or []):
            if not s:
                continue
            key = _normalize_name(s)
            if key and key not in index:
                index[key] = d
    for d in (x for x in definitions if x.user_id is None and x.scope != "global"):
        for s in list(d.names.values()) + (d.synonyms or []):
            if not s:
                continue
            key = _normalize_name(s)
            if key and key not in index:
                index[key] = d
    return index


def build_local_name_index(
    definitions: list[BiomarkerDefinitionModel], user_id: str
) -> dict[str, BiomarkerDefinitionModel]:
    """Map dynamics-stripped normalized name/synonym -> the user's OWN local
    definition (plus system-shared locals), for cross-document unification of
    locally-defined analytes (the same biomarker worded differently by two
    labs). Globals are NOT part of this index — they keep their own matching
    stages and always win collisions with locals."""
    index: dict[str, BiomarkerDefinitionModel] = {}
    for d in definitions:
        if d.scope != "local":
            continue
        if d.user_id is not None and d.user_id != user_id:
            continue
        for s in list(d.names.values()) + (d.synonyms or []):
            if not s:
                continue
            key = _normalize_name(_strip_dynamics_tokens(s))
            if key and key not in index:
                index[key] = d
    return index


def match_local_def(
    raw_name: str,
    local_index: dict[str, BiomarkerDefinitionModel],
    extra_names: tuple[str, ...] = (),
) -> Optional[BiomarkerDefinitionModel]:
    """Resolve a raw/translated name against the user's own local definitions:
    exact (dynamics-stripped) lookup first, then the guarded local fuzzy rule.

    Returns the local definition, or None when nothing matches well enough —
    the caller then falls through to ``verify_or_create`` exactly as before.
    """
    if not local_index:
        return None
    keys = list(local_index.keys())
    for candidate in (raw_name, *extra_names):
        key = _normalize_name(_strip_dynamics_tokens(candidate or ""))
        if not key:
            continue
        if key in keys:
            return local_index[key]
    best_defn = None
    best_ratio = FUZZY_RATIO_MIN - 1
    for candidate in (raw_name, *extra_names):
        key = _normalize_name(_strip_dynamics_tokens(candidate or ""))
        if not key:
            continue
        for matched_key, _wr, _ in process.extract(
            key, keys, scorer=fuzz.WRatio,
            limit=15, score_cutoff=LOCAL_FUZZY_ACCEPT_SCORE,
        ):
            if len(matched_key) < MIN_FUZZY_KEY_LEN and matched_key != key:
                continue
            if _is_carrier_subset_collision(key, matched_key):
                continue
            if _is_query_subset_of_candidate(key, matched_key):
                # The candidate names a MORE specific analyte (query tokens are
                # a strict subset) — never fold one onto the other.
                continue
            r = fuzz.ratio(key, matched_key)
            if r < FUZZY_RATIO_MIN:
                continue
            if r > best_ratio:
                best_ratio = r
                best_defn = local_index[matched_key]
    return best_defn


def deterministic_match(
    raw_name: str,
    index: dict[str, BiomarkerDefinitionModel],
    extra_names: tuple[str, ...] = (),
) -> Optional[BiomarkerDefinitionModel]:
    """Exact (normalized) lookup of the raw name or any provided alias."""
    for candidate in (raw_name, *extra_names):
        key = _normalize_name(candidate or "")
        if key and key in index:
            return index[key]
    return None


def fuzzy_match(
    raw_name: str,
    index: dict[str, BiomarkerDefinitionModel],
    extra_names: tuple[str, ...] = (),
    score_cutoff: int = FUZZY_ACCEPT_SCORE,
) -> Optional[BiomarkerDefinitionModel]:
    """Best fuzzy match against the name index, or None below the cutoff.

    WRatio can rank short junk subset synonyms (e.g. "tot", "bili") above the
    real analyte name, so we scan the top WRatio candidates and keep the first
    that also passes a length-sensitive Levenshtein guard. This blocks
    cross-analyte partials ("Erythrocyte sedimentation rate" -> "Erythrocyte")
    while still matching genuine qualifiers ("Total bilirubin" -> "Bilirubin").
    """
    keys = list(index.keys())
    if not keys:
        return None
    best_defn = None
    best_ratio = FUZZY_RATIO_MIN - 1
    for candidate in (raw_name, *extra_names):
        key = _normalize_name(candidate or "")
        if not key:
            continue
        for matched_key, _wr, _ in process.extract(
            key, keys, scorer=fuzz.WRatio, limit=15, score_cutoff=score_cutoff
        ):
            if len(matched_key) < MIN_FUZZY_KEY_LEN and matched_key != key:
                continue
            if _is_carrier_subset_collision(key, matched_key):
                # "anti-Toxocara IgG" must not collapse onto the bare "IgG"
                # def — leave unmatched so it resolves to a local definition.
                continue
            r = fuzz.ratio(key, matched_key)
            if r < FUZZY_RATIO_MIN:
                continue
            if r > best_ratio:
                best_ratio = r
                best_defn = index[matched_key]
    return best_defn


def is_grounded(
    search_name: str,
    index: dict[str, BiomarkerDefinitionModel],
    threshold: int = 80,
) -> bool:
    """True when the (already English) name has a genuinely close entry in the
    index. Used to decide whether an LLM LOINC guess may touch global defs.

    Uses token_set_ratio (stricter than WRatio) so random/garbage names — which
    WRatio can score deceptively high on short substrings — are rejected."""
    key = _normalize_name(search_name or "")
    if not key:
        return False
    keys = list(index.keys())
    if not keys:
        return False
    result = process.extractOne(key, keys, scorer=fuzz.token_set_ratio)
    return bool(result and result[1] >= threshold)


def _is_fraction_def(defn: BiomarkerDefinitionModel) -> bool:
    """True when the definition is the percent/fraction form of an analyte."""
    en = (defn.names or {}).get("en", "")
    return isinstance(en, str) and en.endswith("%")


def _fraction_variant(
    match: BiomarkerDefinitionModel, definitions: list[BiomarkerDefinitionModel]
) -> Optional[BiomarkerDefinitionModel]:
    """If `match` is the absolute-count form, return the sibling "… %" (fraction)
    variant so a percent document unit resolves to the fraction analyte.

    Searches across ALL definitions (global and local) rather than only the
    global name index, so the re-route still fires when the fraction variant is
    a locally-seeded/LOINC-promoted definition that is not yet in the index.
    """
    name = (match.names or {}).get("en", "")
    if not name or name.endswith("%"):
        return None
    frac_name = f"{name} %".lower()
    for d in definitions:
        if d.id != match.id and (d.names or {}).get("en", "").lower() == frac_name:
            return d
    return None
