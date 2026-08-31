import asyncio
import hashlib
import json
import logging
import os
import re
import time
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from mistralai import Mistral
from mistralai.utils.retries import BackoffStrategy, RetryConfig
from sqlalchemy.orm import Session

from app import i18n
from app.api.auth import get_current_user_or_anon
from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.db.models import CategoryTranslationCache, Patient
from app.db.session import SessionLocal, get_db
from app.schemas.ai import (
    CategoryTranslationItem,
    CommitTranslationRequest,
    RawInstrumentalData,
    StandardizedMedicalRecord,
    StandardizedVisitData,
    TranslateRequest,
    TranslateResponse,
    TranslationBatch,
    TranslationItem,
)
from app.services import extractor, matcher, timing_stats
from app.services.chat_client import build_chat_aware_client
from app.services.language_detect import detect_source_language
from app.services.usage_limits import check_and_record_ai_usage, refund_ai_extraction
from config import MISTRAL_CHAT_MODEL

logger = logging.getLogger(__name__)

router = APIRouter()

TRANSLATE_BIOMARKER_PROMPT = """You are a professional medical translator for laboratory reports. Translate each English biomarker name into {lang}.

Rules:
- Use the standard medical term in {lang} used on laboratory reports.
- Keep Latin acronyms, abbreviations, and numbers verbatim (e.g. "LDL Cholesterol" -> "Colesterol LDL", "Vitamin B12" -> "Vitamina B12", "TSH", "CRP", "HIV" stay unchanged).
- Laboratory class codes — short all-caps identifiers, optionally with slashes (e.g. "HEM/BC", "CHEM", "COAG") — must stay EXACTLY unchanged: never re-spell, transliterate, or partially translate them.
- Items are usually English, but section/panel headings may arrive in another language (e.g. Russian "Клинический анализ крови"). Translate those into {lang} just the same — never echo an item back in a language other than {lang}, unless it is a Latin term, an acronym/class code, or a proper noun.
- Preserve clinical qualifiers verbatim — never drop or rephrase them (e.g. "Free T4", "Total", "Direct", "Indirect", "Estimated", "Urine" must survive in the translation).
- If a name is untranslatable (Latin term like "Escherichia coli" or "Bacteroides spp", drug name, proper noun), return it unchanged.
- NEVER omit an item from the response: even when the name stays unchanged, echo its token with the identical name.
- If the input name is empty, return an empty string for its token.
- Translate the name only — never add interpretations, units, or reference ranges.
- Each item carries a short token (`t1`, `t2`, ...). Echo the exact token back unchanged in the response — never invent, renumber, or merge tokens.
- Return exactly one translated name per input line, in the same order.

{glossary}Items (one per line: `token | name`):
{items}
"""

# At most this many names per LLM call: keeps each response comfortably
# within its ``max_tokens`` budget so a large dictionary cannot truncate into
# a silent English fallback.
TRANSLATE_CHUNK_SIZE = 45
TRANSLATE_MAX_TOKENS = 2000

# Last-chance straggler calls use smaller chunks: they carry only the ids
# earlier passes dropped, and maximizing their success rate is worth the
# extra call.
TRANSLATE_STRAGGLER_CHUNK_SIZE = 20

# Category strings ride the same LLM batch as names under synthetic ids with
# this prefix (md5-based, so they can never collide with real definition ids:
# LOINC codes and "local-<md5>" ids contain no colon). The prefix is stripped
# before the results go back to the client.
_CATEGORY_ID_PREFIX = "category:"


def _category_cache_id(lang: str, cleaned: str) -> str:
    """Primary key of the shared category-translation cache row for a cleaned
    heading in a language."""
    return f"{lang}:{hashlib.sha256(cleaned.encode()).hexdigest()}"


def _get_client() -> Optional[Mistral]:
    api_key = os.getenv("MISTRAL_API_KEY")
    if not api_key:
        return None
    # Bound the OCR/LLM requests so a slow or oversized document fails fast
    # instead of hanging the SSE stream (and the UI's "estimating..." state)
    # indefinitely. 300s gives the Files-API upload + OCR of a large phone
    # photo enough headroom (normal case is ~15s) without hanging forever.
    # retry_config makes the SDK transparently retry transient failures
    # (429 rate-limit, 5xx) with exponential backoff. Without it, a single
    # rate-limited call surfaces as a failed extraction and — because the
    # Mistral API rate-limits per account — poisons every subsequent request
    # in the same process (the documented "contamination" bug that makes
    # later e2e cases return 'unknown').
    retry_config = RetryConfig(
        strategy="backoff",
        backoff=BackoffStrategy(
            initial_interval=1000,
            max_interval=15000,
            exponent=2.0,
            max_elapsed_time=120000,
        ),
        retry_connection_errors=True,
    )
    mistral = Mistral(api_key=api_key, timeout_ms=300_000, retry_config=retry_config)
    # Env-gated provider split: chat LLM via OpenRouter, OCR stays Mistral
    # (default: unchanged plain-Mistral behavior). See app.services.chat_client.
    return build_chat_aware_client(mistral)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def _sse_response(response: Response, body) -> StreamingResponse:
    """SSE StreamingResponse carrying the headers dependencies set on the
    injected ``Response``. FastAPI only merges dependency-set headers when the
    endpoint returns a plain (non-Response) value, so returning a
    StreamingResponse directly would silently drop the anonymous session
    ``Set-Cookie`` issued by ``get_current_user_or_anon`` (ISSUES.md #38)."""
    resp = StreamingResponse(
        body,
        media_type="text/event-stream",
        headers={
            # Prevent proxies (nginx, etc.) from buffering the SSE stream so
            # progress events reach the client incrementally instead of all at once.
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
    for name, value in response.raw_headers:
        if name.lower() == b"set-cookie":
            resp.raw_headers.append((name, value))
    return resp


KEEPALIVE_INTERVAL_S = 15.0


def _keepalive() -> str:
    """SSE comment line (ignored by clients) that keeps the connection and any
    buffering proxy alive during the long silent OCR/LLM/matching phases, so a
    healthy-but-slow extraction is never mistaken for a dead one."""
    return ": keep-alive\n\n"


async def _wait_with_keepalive(awaitable: asyncio.Future) -> None:
    """Wait on ``awaitable`` (a pending future), yielding an SSE keep-alive
    comment every ``KEEPALIVE_INTERVAL_S`` seconds until it resolves.

    Consume with ``async for`` inside the SSE stream; then read the result via
    ``awaitable.result()``, which re-raises any exception the worker thread
    produced. Cancellation of the waiting task is not swallowed.
    """
    while not awaitable.done():
        done, _ = await asyncio.wait({awaitable}, timeout=KEEPALIVE_INTERVAL_S)
        if done:
            return
        yield _keepalive()


def _refund_on_abort(db: Session, user_id: str, is_anonymous: bool, reason: str) -> None:
    """Best-effort quota refund for an extraction that never delivered a result
    because the client disconnected mid-stream.

    Never raises (the request session may already be tearing down), so the
    original cancellation/GeneratorExit always propagates.
    """
    try:
        refund_ai_extraction(db, user_id, is_anonymous)
        logger.info("Extraction %s by client — quota refunded", reason)
    except Exception:
        logger.warning("Quota refund for %s extraction failed", reason, exc_info=True)


def _clean_translation_name(name: str) -> str:
    """Normalize a biomarker name for the LLM prompt: collapse all whitespace
    (including newlines — a name must never smuggle extra prompt lines),
    remove the ``|`` delimiter that separates id and name, and neutralize
    ``{``/``}`` so a name can never break the prompt's ``str.format``."""
    return " ".join(name.replace("|", " ").replace("{", " ").replace("}", " ").split())


def _chunks(seq: list, size: int):
    """Yield ``seq`` in slices of at most ``size`` items."""
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


class _TranslationRateLimited(Exception):
    """Raised inside ``_translate_names_to_lang`` when Mistral answers 429 even
    after the SDK's own retry/backoff: further calls would be doomed, so the
    remaining chunks are skipped and partial results are returned."""


def _is_rate_limit_error(exc: Exception) -> bool:
    """True when ``exc`` looks like a Mistral 429 (rate limit). The SDK raises
    ``MistralError`` subclasses carrying ``status_code``; message/type-name
    matching covers unexpected wrappers (and test doubles)."""
    if getattr(exc, "status_code", None) == 429:
        return True
    return "429" in type(exc).__name__ or "status 429" in str(exc).lower()


def _extract_translation_json(content) -> Optional[TranslationBatch]:
    """Parse the LLM's raw response content into a TranslationBatch.

    Tolerates code-fence wrapping and verbose prose around the JSON (the SDK
    may return the stringified JSON even with ``response_format`` set).
    Returns ``None`` when no usable JSON can be recovered.
    """
    if not isinstance(content, str):
        return content
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return TranslationBatch(**json.loads(text))
    except (ValueError, TypeError):
        pass
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return TranslationBatch(**json.loads(text[start : end + 1]))
    except (ValueError, TypeError):
        return None


def _chat_parse_translation(
    chunk: list[tuple[str, str]], lang: str, client: Mistral, glossary: dict[str, str]
) -> tuple[Optional[TranslationBatch], Optional[dict[str, tuple[str, str]]]]:
    """One LLM call for ``chunk`` (token-tagged items).

    Returns ``(parsed batch, token -> (def id, cleaned input name) map)``, or
    ``(None, None)`` when the call or the parse failed. ``glossary``
    (en -> translated) seeds the prompt so the model keeps the style of
    already-translated names.
    """
    id_by_token = {f"t{i + 1}": (def_id, name) for i, (def_id, name) in enumerate(chunk)}
    item_lines = "\n".join(
        f'- "{token} | {name}"' for token, (_def_id, name) in id_by_token.items()
    )
    glossary_block = ""
    if glossary:
        pairs = "\n".join(
            f'- "{_clean_translation_name(en)}" -> "{translated}"'
            for en, translated in glossary.items()
        )
        glossary_block = (
            "Reference translations already in use (match their style exactly):\n"
            f"{pairs}\n\n"
        )
    system_prompt = TRANSLATE_BIOMARKER_PROMPT.format(
        lang=lang, items=item_lines, glossary=glossary_block
    )
    try:
        chat_response = client.chat.parse(
            model=MISTRAL_CHAT_MODEL,
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Return the JSON array now."},
            ],
            response_format=TranslationBatch,
            max_tokens=TRANSLATE_MAX_TOKENS,
        )
    except Exception as e:
        if _is_rate_limit_error(e):
            # The SDK's retry_config has already retried with backoff by the
            # time this surfaces — sustained rate limiting, not a blip. Abort
            # the remaining work instead of burning minutes on doomed calls.
            logger.error("Name translation rate-limited by Mistral (%s)", lang)
            raise _TranslationRateLimited() from e
        logger.error("Name translation LLM call failed (%s): %s", lang, e)
        return None, None
    parsed = _extract_translation_json(chat_response.choices[0].message.content)
    if parsed is None:
        logger.error("Failed to parse name translation response (%s)", lang)
        return None, None
    return parsed, id_by_token


def _merge_translation_chunk(
    parsed: TranslationBatch,
    id_by_token: dict[str, tuple[str, str]],
    result: dict[str, str],
) -> None:
    """Merge a parsed batch into ``result`` via the token map. Unknown tokens
    are skipped, duplicate tokens are last-wins. A known token answered with
    an EMPTY string means the model deemed the name untranslatable — keep the
    input name (kept-as-is) instead of dropping the id into the retry/
    straggler path, which would end in a false "English fallback"."""
    for t in parsed.translations:
        token = (t.id or "").strip()
        entry = id_by_token.get(token)
        if entry is None:
            continue
        def_id, input_name = entry
        translated = (t.name or "").strip()
        result[def_id] = translated or input_name


def _translate_chunk(
    chunk: list[tuple[str, str]],
    lang: str,
    client: Mistral,
    glossary: dict[str, str],
    result: dict[str, str],
    retry: bool,
) -> list[tuple[str, str]]:
    """Translate one chunk, merging into ``result``; returns the ids still
    missing. When ``retry``, a failed call/parse or dropped ids trigger ONE
    smaller retry call."""
    if not chunk:
        return []
    parsed, id_by_token = _chat_parse_translation(chunk, lang, client, glossary)
    if parsed is not None:
        _merge_translation_chunk(parsed, id_by_token, result)
    missing = [(def_id, name) for def_id, name in chunk if def_id not in result]
    if retry and missing:
        parsed, id_by_token = _chat_parse_translation(missing, lang, client, glossary)
        if parsed is not None:
            _merge_translation_chunk(parsed, id_by_token, result)
    return [(def_id, name) for def_id, name in chunk if def_id not in result]


def _translate_names_to_lang(
    items: list[tuple[str, str]],
    lang: str,
    client: Mistral,
    glossary: Optional[dict[str, str]] = None,
) -> dict[str, str]:
    """Translate English biomarker names into ``lang`` via chunked LLM calls.

    ``items`` is a list of ``(def id, english name)`` pairs. Returns a mapping
    def id -> translated name. Best-effort: on any LLM failure an empty (or
    partial) mapping is returned and callers fall back to the English names
    per id.

    Names are sanitized before sending (empty or whitespace-only names are
    skipped, so the model can never invent a translation for one). Items are
    split into chunks of at most ``TRANSLATE_CHUNK_SIZE`` (each call is
    bounded by ``TRANSLATE_MAX_TOKENS`` so a large dictionary cannot truncate
    into a silent English fallback); within a chunk the model is given
    positional tokens ``t1..tN`` (immune to the model mangling opaque def ids)
    and ids the model drops are retried once with a smaller call. A response
    that fails to parse (truncation, code fences) is retried once. Ids still
    missing after all chunks get final smaller straggler calls (with their
    own drop-retry) — every extra call is spent before an id is allowed to
    fall back to English. A sustained Mistral 429 aborts the remaining chunks
    and returns what translated so far.
    """
    if not items or client is None:
        return {}

    pending: list[tuple[str, str]] = []
    seen_ids: set[str] = set()
    for def_id, name in items:
        cleaned = _clean_translation_name(name)
        if not cleaned or def_id in seen_ids:
            continue
        seen_ids.add(def_id)
        pending.append((def_id, cleaned))

    result: dict[str, str] = {}

    try:
        # Pass 1: one call per chunk, with one drop/parse retry per chunk.
        leftovers: list[tuple[str, str]] = []
        for chunk in _chunks(pending, TRANSLATE_CHUNK_SIZE):
            leftovers.extend(_translate_chunk(chunk, lang, client, glossary, result, retry=True))

        # Pass 2 (stragglers): smaller chunks and a drop/parse retry each —
        # this is the last chance before an id falls back to English.
        for chunk in _chunks(leftovers, TRANSLATE_STRAGGLER_CHUNK_SIZE):
            _translate_chunk(chunk, lang, client, glossary, result, retry=True)
    except _TranslationRateLimited:
        # Sustained rate limiting: skip the remaining chunks instead of
        # stacking more doomed calls on top of the SDK's own retries;
        # untranslated ids fall back to English upstream.
        pass

    missed = [def_id for def_id, _name in pending if def_id not in result]
    if missed:
        logger.warning(
            "Name translation (%s): %d/%d ids fell back to English after all passes",
            lang,
            len(missed),
            len(pending),
        )

    return result


@router.post("/api/extract")
async def extract_medical_data(
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    _user, user_id, is_anonymous = user_data
    if not file.filename:
        raise HTTPException(status_code=400, detail=i18n.tr("ai.no_filename"))

    # Resolve the client BEFORE consuming quota: if MISTRAL_API_KEY is missing
    # the request can never succeed, so we must not burn the user's extraction
    # count (anonymous users in particular get locked out after 5 doomed tries).
    client = _get_client()
    if client is None:
        async def error_stream():
            yield _sse("error", {"message": i18n.tr("ai.sse_no_mistral_key")})
        return _sse_response(response, error_stream())

    # Check AI extraction limit. Defer the commit (commit=False) so a request
    # that fails file validation below does not burn the user's extraction
    # count — the commit happens only once the file is known to be usable.
    allowed, current_count, limit = check_and_record_ai_usage(db, user_id, is_anonymous, commit=False)
    if not allowed:
        if is_anonymous:
            detail = i18n.tr("ai.extraction_limit_anon", current=current_count, limit=limit)
        else:
            detail = i18n.tr("ai.extraction_limit_registered", current=current_count, limit=limit)
        raise HTTPException(status_code=429, detail=detail)

    try:
        bytes_data = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=i18n.tr("ai.read_file_failed", error=e)) from e

    if not bytes_data:
        raise HTTPException(status_code=400, detail=i18n.tr("ai.empty_file"))

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in extractor.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=i18n.tr("ai.unsupported_file_type", ext=ext, allowed=", ".join(sorted(extractor.ALLOWED_EXTENSIONS))),
        )

    # File validated — persist the extraction-count increment now.
    db.commit()

    definitions = db.query(BiomarkerDefinitionModel).filter(
        (BiomarkerDefinitionModel.scope == "global")
        | (BiomarkerDefinitionModel.user_id == user_id)
        # System-shared local definitions (user_id IS NULL) such as curated
        # local-only analytes (e.g. "Activated lymphocytes") are available to
        # every user, including anonymous sessions, so they can be matched.
        | (BiomarkerDefinitionModel.user_id.is_(None))
    ).all()
    definitions.sort(key=lambda d: (d.category or "", d.names.get("en", "") or ""))
    # Detach definition ORM instances from the request-scoped session so their
    # already-loaded attributes are safe to read from the worker thread below.
    # SQLAlchemy Sessions are not thread-safe; matcher will use its own session.
    for d in definitions:
        db.expunge(d)

    logger.info("File: %s, size: %d bytes, type: %s, user: %s", file.filename, len(bytes_data), ext, user_id)

    async def event_stream():
        error = None
        markdown = None
        try:
            # Stage 1: OCR
            yield _sse("progress", {"stage": "ocr_scanning"})
            t0 = time.perf_counter()
            ocr_future = asyncio.get_running_loop().run_in_executor(
                None, extractor.ocr_document, bytes_data, ext, client
            )
            try:
                async for keepalive in _wait_with_keepalive(ocr_future):
                    yield keepalive
                markdown = ocr_future.result()
            except extractor.OCRProcessingError as ocr_err:
                # OCR classification runs in an executor thread where the
                # locale ContextVar is invisible — localize here, in the
                # request context, from the typed error's `kind`.
                if ocr_err.kind == "auth":
                    error = i18n.tr_opt("ai.ocr_auth", status=getattr(ocr_err, "http_status", "401/403"))
                else:
                    error = i18n.tr_opt(f"ai.ocr_{ocr_err.kind}")
                if error is None:
                    error = ocr_err.message
            elapsed = time.perf_counter() - t0
            logger.info("OCR took %.2fs — %d chars", elapsed, len(markdown) if markdown else 0)
            if markdown:
                # Only successful OCR samples feed the timing stats — a
                # failure's duration is time-to-error, not latency data.
                timing_stats.record(timing_stats.STAGE_OCR, elapsed)

            if not error and not markdown:
                error = i18n.tr("ai.sse_no_text")

            # Deterministic source-language detection on the full OCR text —
            # runs once here (never an LLM field) and rides both result events
            # below so the client can persist it on the entry.
            source_language = detect_source_language(markdown) if markdown else None

            # Stage 2: LLM extraction
            if not error:
                yield _sse("progress", {
                    "stage": "extracting",
                    "markdown_chars": len(markdown),
                    "estimate_s": round(timing_stats.estimate(timing_stats.STAGE_EXTRACT, len(markdown)), 1),
                })
                t0 = time.perf_counter()
                llm_future = asyncio.get_running_loop().run_in_executor(
                    None, extractor.llm_extract, markdown, client
                )
                async for keepalive in _wait_with_keepalive(llm_future):
                    yield keepalive
                raw = llm_future.result()
                elapsed = time.perf_counter() - t0
                bm_count = len(raw.biomarkers) if raw.biomarkers else 0
                logger.info("Extraction took %.2fs — type: %s, biomarkers: %d", elapsed, raw.entry_type, bm_count)
                timing_stats.record(timing_stats.STAGE_EXTRACT, elapsed, len(markdown))

            if error:
                # The extraction count was committed before OCR/LLM ran; refund
                # it so a failed document doesn't burn one of the (limited)
                # AI extractions for nothing.
                refund_ai_extraction(db, user_id, is_anonymous)
                yield _sse("error", {"message": error})
                return

            if raw.entry_type == "unknown":
                yield _sse(
                    "result",
                    StandardizedMedicalRecord(
                        entry_type="unknown",
                        date=raw.date,
                        time=raw.time,
                        clinic=raw.clinic,
                        provider=raw.provider,
                        title=raw.title,
                        notes=raw.notes,
                        source_language=source_language,
                        biomarkers=[],
                        visit_data=StandardizedVisitData(),
                        instrumental_data=RawInstrumentalData(),
                    ).model_dump(),
                )
                return

            # Stage 3: Matching
            yield _sse("progress", {
                "stage": "matching",
                "biomarker_count": bm_count,
                "estimate_s": round(timing_stats.estimate(timing_stats.STAGE_MATCH), 1),
            })
            t0 = time.perf_counter()

            def _match_in_thread():
                # Use a thread-local Session — the request's `db` is bound to
                # the event-loop thread and must not be shared.
                thread_db = SessionLocal()
                try:
                    result = matcher.match_and_convert(raw, definitions, thread_db, user_id, client)
                    thread_db.commit()
                    return result
                except Exception:
                    thread_db.rollback()
                    raise
                finally:
                    thread_db.close()

            match_future = asyncio.get_running_loop().run_in_executor(None, _match_in_thread)
            async for keepalive in _wait_with_keepalive(match_future):
                yield keepalive
            result = match_future.result()
            elapsed = time.perf_counter() - t0
            std_count = len(result.biomarkers) if result.biomarkers else 0
            logger.info("Matching took %.2fs — biomarkers: %d", elapsed, std_count)
            timing_stats.record(timing_stats.STAGE_MATCH, elapsed)

            result.source_language = source_language
            yield _sse("result", result.model_dump())
            return

        except asyncio.CancelledError:
            # Client disconnected mid-stream: the extraction never delivered a
            # result, so refund the already-charged quota (best-effort — the
            # request session may be tearing down).
            _refund_on_abort(db, user_id, is_anonymous, "cancelled")
            raise
        except GeneratorExit:
            # Generator closed while suspended (client went away before
            # completion): same refund, then keep propagating.
            _refund_on_abort(db, user_id, is_anonymous, "closed early")
            raise
        except Exception as e:
            logger.error("Extraction stream failed: %s", e, exc_info=True)
            error = str(e)

        if error:
            # Same refund as the explicit failure paths above: the stream died
            # before producing a result, so the charged extraction is refunded.
            refund_ai_extraction(db, user_id, is_anonymous)
            yield _sse("error", {"message": error})

    return _sse_response(response, event_stream())


def _category_translations(
    requested: list[str], translated_cats: dict[str, str]
) -> list[CategoryTranslationItem]:
    """Build the category part of the response: one item per distinct cleaned
    input string in first-seen order. ``translated_cats`` maps the CLEANED
    string to its translation; anything missing (LLM failure or empty input)
    falls back to the original request string with source="fallback"."""
    items: list[CategoryTranslationItem] = []
    seen: set[str] = set()
    for raw in requested:
        cleaned = _clean_translation_name(raw)
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        tr = translated_cats.get(cleaned)
        items.append(
            CategoryTranslationItem(
                original=raw,
                translated=tr or raw,
                source="translated" if tr else "fallback",
            )
        )
    return items


def _translation_response(
    payload: TranslateRequest,
    defn_by_id: dict,
    translated: dict[str, str],
    translated_cats: Optional[dict[str, str]] = None,
) -> TranslateResponse:
    """Build the response in request order: every requested id comes back with
    its persisted translation when one exists, else the requested (English)
    name, plus a per-item ``source`` classification — ``translated`` (newly
    LLM-translated this request), ``cached`` (definition already carried
    ``names[lang]``), or ``fallback`` (LLM failure, unresolvable/foreign id,
    or empty name). Categories follow the same shape but are never persisted,
    so they only ever classify as ``translated`` / ``fallback``."""
    translations: list[TranslationItem] = []
    for item in payload.names:
        defn = defn_by_id.get(item.id)
        persisted = (defn.names or {}).get(payload.lang) if defn is not None else None
        if item.id in translated:
            source = "translated"
        elif persisted:
            source = "cached"
        else:
            source = "fallback"
        # A freshly translated name wins over the (stale or absent) persisted
        # one — with persist=False nothing was written, so this is the only
        # place the new translation exists.
        name = translated.get(item.id) or persisted or item.name
        translations.append(TranslationItem(id=item.id, name=name, source=source))
    return TranslateResponse(
        translations=translations,
        categories=_category_translations(payload.categories, translated_cats or {}),
    )


@router.post("/api/translate-biomarkers", response_model=TranslateResponse)
async def translate_biomarker_names(
    payload: TranslateRequest,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """Translate the English names of the user's biomarker definitions into a
    target language and persist each translation into the definition's
    ``names[lang]`` JSON column, so every later render (flowsheet, print
    editor) reads it without another LLM call.

    Category/panel heading strings (``payload.categories``) ride the same LLM
    batch under synthetic ids but are NEVER written to the definitions — they
    come back in the response keyed by their exact input string, for this
    document render only. Fresh heading translations land in a shared
    ``category_translation_cache`` table (keyed by language + cleaned string,
    all users, never invalidated) so later requests with the same headings are
    served without an LLM call.

    Best-effort: definitions that already carry ``names[lang]`` are returned
    untouched (no LLM call, no quota charge); on total LLM failure the request
    still succeeds with the original English names/categories and the charged
    quota is refunded. Quota is charged only when there is actual LLM work — a
    fully-cached request (all names persisted, all headings cached) is free.
    Every returned item carries a ``source`` classification (``translated`` /
    ``cached`` / ``fallback``, categories only ever ``translated`` /
    ``fallback``) so clients can surface silent fallbacks.
    """
    _user, user_id, is_anonymous = user_data

    if not payload.names and not payload.categories:
        return TranslateResponse(translations=[], categories=[])

    # Resolve only definitions visible to this user (global, system-shared, or
    # their own); a foreign or unresolvable id is returned with its original
    # name untouched and never written.
    ids = list({item.id for item in payload.names})
    defns = (
        db.query(BiomarkerDefinitionModel)
        .filter(
            BiomarkerDefinitionModel.id.in_(ids),
            (BiomarkerDefinitionModel.scope == "global")
            | (BiomarkerDefinitionModel.user_id.is_(None))
            | (BiomarkerDefinitionModel.user_id == user_id),
        )
        .all()
    )
    defn_by_id = {d.id: d for d in defns}

    to_translate: list[tuple[str, str]] = []  # (def id, english name)
    seen_ids: set[str] = set()
    for item in payload.names:
        defn = defn_by_id.get(item.id)
        if defn is None or (defn.names or {}).get(payload.lang) or item.id in seen_ids:
            continue
        seen_ids.add(item.id)
        to_translate.append((item.id, item.name))

    # Category headings: dedupe by cleaned string, one synthetic id each.
    cat_id_by_cleaned: dict[str, str] = {}  # cleaned category -> synthetic id
    for raw in payload.categories:
        cleaned = _clean_translation_name(raw)
        if not cleaned or cleaned in cat_id_by_cleaned:
            continue
        digest = hashlib.md5(cleaned.encode()).hexdigest()[:12]
        cat_id_by_cleaned[cleaned] = f"{_CATEGORY_ID_PREFIX}{digest}"

    # Serve headings from the shared cache first: generic lab terms repeat
    # across documents and users, so only cache misses reach the LLM.
    cached_cats: dict[str, str] = {}  # cleaned category -> translation
    if cat_id_by_cleaned:
        cache_rows = (
            db.query(CategoryTranslationCache)
            .filter(
                CategoryTranslationCache.id.in_(
                    [
                        _category_cache_id(payload.lang, cleaned)
                        for cleaned in cat_id_by_cleaned
                    ]
                )
            )
            .all()
        )
        cached_cats = {row.original: row.translated for row in cache_rows}
    # Only cache misses are sent to the LLM.
    cat_items = [
        (cid, cleaned)
        for cleaned, cid in cat_id_by_cleaned.items()
        if cleaned not in cached_cats
    ]

    if not to_translate and not cat_items:
        # Everything is already known (persisted names + cached headings):
        # return it without burning quota (re-generates of an
        # already-translated document are free).
        return _translation_response(
            payload, defn_by_id, translated={}, translated_cats=cached_cats
        )

    # The LLM call can never succeed without a key, so never charge quota for
    # a request that would have to fall back to English anyway.
    client = _get_client()
    if client is None:
        return _translation_response(
            payload, defn_by_id, translated={}, translated_cats=cached_cats
        )

    allowed, current_count, limit = check_and_record_ai_usage(db, user_id, is_anonymous, commit=False)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=i18n.tr("ai.translation_limit_reached", current=current_count, limit=limit),
        )

    # Seed the prompts with translations already persisted for this language
    # (short-circuited defs that never reach ``to_translate``) so the new
    # batch stays stylistically consistent with them.
    glossary: dict[str, str] = {}
    for item in payload.names:
        defn = defn_by_id.get(item.id)
        if defn is None:
            continue
        existing = (defn.names or {}).get(payload.lang)
        en_name = (defn.names or {}).get("en") or item.name
        if existing and en_name and existing != en_name:
            glossary[en_name] = existing
    # Cached heading translations steer the style of fresh ones the same way.
    for cleaned, tr in cached_cats.items():
        glossary.setdefault(cleaned, tr)

    unique_items = list({item_id: name for item_id, name in to_translate}.items())
    # Names and categories share one batched call: the chunk/retry machinery is
    # id-based, so categories just join under their synthetic ids.
    combined = _translate_names_to_lang(
        [*unique_items, *cat_items], payload.lang, client, glossary=glossary
    )
    defn_ids = {item_id for item_id, _name in unique_items}
    translated = {k: v for k, v in combined.items() if k in defn_ids}
    cleaned_by_cat_id = {
        cid: cleaned
        for cleaned, cid in cat_id_by_cleaned.items()
        if cleaned not in cached_cats
    }
    fresh_cats = {
        cleaned_by_cat_id[k]: v for k, v in combined.items() if k in cleaned_by_cat_id
    }
    translated_cats = {**cached_cats, **fresh_cats}
    if not combined:
        # The LLM failed after the quota increment was flushed: refund it.
        # Cached headings stay valid — they still go back to the client.
        refund_ai_extraction(db, user_id, is_anonymous)
        return _translation_response(
            payload, defn_by_id, translated={}, translated_cats=cached_cats
        )

    # Remember fresh heading translations in the shared cache (same commit as
    # the name persistence / quota increment). merge() keeps this idempotent
    # against a concurrent request inserting the same row. The shared cache is
    # only populated by authenticated principals — an anonymous caller must
    # never be able to seed poisoned headings that every user's render then
    # trusts (see ISSUES.md #33).
    if not is_anonymous:
        for cleaned, tr in fresh_cats.items():
            db.merge(
                CategoryTranslationCache(
                    id=_category_cache_id(payload.lang, cleaned),
                    original=cleaned,
                    translated=tr,
                )
            )

    # Persisting into definitions' names[lang] likewise requires an
    # authenticated principal: anonymous callers may read/translate but must
    # not be able to rewrite shared (global/system) definitions (ISSUES.md #32).
    if payload.persist and not is_anonymous:
        # Persist each translation into the definition's names JSON column so
        # every later render reads it without another LLM call. Committing here
        # also persists the quota increment.
        for def_id, _en_name in to_translate:
            defn = defn_by_id.get(def_id)
            if defn is None:
                continue
            translated_name = translated.get(def_id)
            if not translated_name:
                continue
            names = dict(defn.names or {})
            names[payload.lang] = translated_name
            defn.names = names
    # With persist=False (review flow) the names are NOT written — the client
    # confirms them via /translate-biomarkers/commit. The quota increment IS
    # committed either way: the LLM genuinely ran. Categories are never
    # written; they exist only in this response.
    db.commit()

    return _translation_response(
        payload, defn_by_id, translated=translated, translated_cats=translated_cats
    )


@router.post("/api/translate-biomarkers/commit")
async def commit_translated_names(
    payload: CommitTranslationRequest,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """Persist reviewed translations (``{id, name}``) chosen in the print-setup
    review dialog into the definitions' ``names[lang]`` column. No LLM call and
    no quota charge — the LLM already ran in the preceding
    ``persist:false /translate-biomarkers`` request; this only writes the terms
    the user accepted. Unresolvable or foreign ids are skipped silently."""
    _user, user_id, _is_anonymous = user_data

    # Only authenticated principals may write translations. Anonymous callers
    # must not be able to rewrite shared (global/system) definitions that every
    # user's flowsheet/print renders (ISSUES.md #32).
    if _is_anonymous:
        raise HTTPException(
            status_code=403,
            detail=i18n.tr("ai.auth_required_persist"),
        )

    ids = [item.id for item in payload.items]
    defns = (
        db.query(BiomarkerDefinitionModel)
        .filter(
            BiomarkerDefinitionModel.id.in_(ids),
            (BiomarkerDefinitionModel.scope == "global")
            | (BiomarkerDefinitionModel.user_id.is_(None))
            | (BiomarkerDefinitionModel.user_id == user_id),
        )
        .all()
        if ids
        else []
    )
    defn_by_id = {d.id: d for d in defns}

    saved = 0
    for item in payload.items:
        name = (item.name or "").strip()
        defn = defn_by_id.get(item.id)
        if defn is None or not name:
            continue
        names = dict(defn.names or {})
        names[payload.lang] = name
        defn.names = names
        saved += 1
    db.commit()
    return {"saved": saved}
