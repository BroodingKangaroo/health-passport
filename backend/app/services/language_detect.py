"""Deterministic source-language detection for extracted documents.

Runs on the raw OCR markdown at extraction time (no LLM call — prompt changes
would risk e2e golden drift and benchmark spend for a field the goldens never
compare). Returns a code from a fixed allowlist, or None when the document is
too short / ambiguous to decide; callers persist None as "unknown".
"""

import re
from typing import Optional

# The only values detect_source_language may return. Everything downstream
# (persistence, serializers, frontend labels) validates against this set.
SUPPORTED_LANGUAGES = ("en", "de", "fr", "es", "pl", "ru", "he")

# Unicode script ranges (codepoint ranges, not regex scripts, so they work
# on any Python build).
_CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")
_HEBREW_RE = re.compile(r"[\u0590-\u05FF]")
_LETTER_RE = re.compile(r"[^\W\d_]+", re.UNICODE)

# A letter must be covered by one of the scored scripts below for the script
# pass to fire; Latin letters are handled by the word pass.
_LATIN_RE = re.compile(r"[A-Za-z\u00C0-\u024F]")

# Share of all letters a script must cover to decide by script alone.
_SCRIPT_THRESHOLD = 0.2

# Polish is detectable from its diacritics alone (no other allowlist language
# uses ą/ć/ę/ł/ń/ó/ś/ź/ż in running text).
_POLISH_DIACRITICS_RE = re.compile(r"[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]")

# Common-word frequency sets for Latin-script languages. Counted on
# lowercased word tokens extracted from the whole document.
_COMMON_WORDS: dict[str, frozenset[str]] = {
    "en": frozenset({
        "the", "and", "of", "with", "for", "was", "are", "not", "this",
        "patient", "test", "result", "blood", "count",
    }),
    "de": frozenset({
        "der", "die", "das", "und", "mit", "nicht", "ist", "im", "von",
        "patient", "untersuchung", "ergebnis", "blut", "befund",
    }),
    "fr": frozenset({
        "le", "la", "les", "et", "des", "une", "est", "dans", "pour",
        "patient", "resultat", "sang", "analyse",
    }),
    "es": frozenset({
        "el", "los", "las", "que", "con", "por", "para", "del", "una",
        "paciente", "resultado", "sangre", "analisis",
    }),
    "pl": frozenset({
        "oraz", "nie", "jest", "się", "dla", "przy", "brak", "pacjent",
        "wynik", "badania", "krwi",
    }),
}

# The word pass needs this many scored hits for a language before it may
# decide, and the winner must beat the runner-up by this margin (absolute
# token count) — short mixed-language fragments stay None.
_MIN_WORD_HITS = 4
_MIN_WORD_MARGIN = 2


def detect_source_language(text) -> Optional[str]:
    """Best-effort deterministic language code for a document, or None."""
    if not text:
        return None
    letters = _LETTER_RE.findall(text)
    total = sum(len(w) for w in letters)
    if total < 40:
        return None

    cyr = sum(len(m) for m in _CYRILLIC_RE.findall(text))
    heb = sum(len(m) for m in _HEBREW_RE.findall(text))
    if cyr / total >= _SCRIPT_THRESHOLD:
        return "ru"
    if heb / total >= _SCRIPT_THRESHOLD:
        return "he"

    # Latin-script pass: token frequency + Polish diacritics.
    latin = sum(len(m.group()) for m in _LATIN_RE.finditer(text))
    if latin / total < 0.5:
        return None
    tokens = [w.lower() for w in letters]
    scores = {lang: sum(1 for t in tokens if t in words) for lang, words in _COMMON_WORDS.items()}
    scores["pl"] += 2 * len(_POLISH_DIACRITICS_RE.findall(text))
    best = max(scores, key=lambda lang: scores[lang])
    best_score = scores[best]
    if best_score < _MIN_WORD_HITS:
        return None
    runner_up = max(s for lang, s in scores.items() if lang != best)
    if best_score - runner_up < _MIN_WORD_MARGIN:
        return None
    return best
