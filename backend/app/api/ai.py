import asyncio
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

from app.api.auth import get_current_user_or_anon
from app.db.models import BiomarkerDefinition as BiomarkerDefinitionModel
from app.db.models import Patient
from app.db.session import SessionLocal, get_db
from app.schemas.ai import (
    RawInstrumentalData,
    StandardizedMedicalRecord,
    StandardizedVisitData,
    TranslateRequest,
    TranslateResponse,
    TranslationBatch,
    TranslationItem,
)
from app.services import extractor, matcher
from app.services.usage_limits import check_and_record_ai_usage, refund_ai_extraction

logger = logging.getLogger(__name__)

router = APIRouter()

TRANSLATE_BIOMARKER_PROMPT = """You are a professional medical translator for laboratory reports. Translate each English biomarker name into {lang}.

Rules:
- Use the standard medical term in {lang} used on laboratory reports.
- Keep Latin acronyms, abbreviations, and numbers verbatim (e.g. "LDL Cholesterol" -> "Colesterol LDL", "Vitamin B12" -> "Vitamina B12", "TSH", "CRP", "HIV" stay unchanged).
- Preserve clinical qualifiers verbatim — never drop or rephrase them (e.g. "Free T4", "Total", "Direct", "Indirect", "Estimated", "Urine" must survive in the translation).
- If a name is untranslatable (Latin term, drug name, proper noun), return it unchanged.
- If the input name is empty, return an empty string.
- Translate the name only — never add interpretations, units, or reference ranges.
- Each item carries a short token (`t1`, `t2`, ...). Echo the exact token back unchanged in the response — never invent, renumber, or merge tokens.
- Return exactly one translated name per input line, in the same order.

{glossary}Items (one per line: `token | name`):
{items}
"""

# At most this many names per LLM call: keeps each response comfortably under
# ``max_tokens=1000`` so a large dictionary cannot truncate into a silent
# English fallback.
TRANSLATE_CHUNK_SIZE = 45


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
    return Mistral(api_key=api_key, timeout_ms=300_000, retry_config=retry_config)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


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
) -> tuple[Optional[TranslationBatch], Optional[dict[str, str]]]:
    """One LLM call for ``chunk`` (token-tagged items).

    Returns ``(parsed batch, token -> def id map)``, or ``(None, None)`` when
    the call or the parse failed. ``glossary`` (en -> translated) seeds the
    prompt so the model keeps the style of already-translated names.
    """
    id_by_token = {f"t{i + 1}": def_id for i, (def_id, _name) in enumerate(chunk)}
    item_lines = "\n".join(
        f'- "{token} | {name}"' for token, (_def_id, name) in zip(id_by_token, chunk)
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
            model="mistral-large-latest",
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Return the JSON array now."},
            ],
            response_format=TranslationBatch,
            max_tokens=1000,
        )
    except Exception as e:
        logger.error("Name translation LLM call failed (%s): %s", lang, e)
        return None, None
    parsed = _extract_translation_json(chat_response.choices[0].message.content)
    if parsed is None:
        logger.error("Failed to parse name translation response (%s)", lang)
        return None, None
    return parsed, id_by_token


def _merge_translation_chunk(
    parsed: TranslationBatch, id_by_token: dict[str, str], result: dict[str, str]
) -> None:
    """Merge a parsed batch into ``result`` via the token map: unknown tokens
    are skipped, duplicate tokens are last-wins, empty translations ignored."""
    for t in parsed.translations:
        def_id = id_by_token.get((t.id or "").strip())
        if def_id is None:
            continue
        translated = (t.name or "").strip()
        if translated:
            result[def_id] = translated


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
    bounded by ``max_tokens=1000`` so a large dictionary cannot truncate into
    a silent English fallback); within a chunk the model is given positional
    tokens ``t1..tN`` (immune to the model mangling opaque def ids) and ids
    the model drops are retried once with a smaller call. A response that
    fails to parse (truncation, code fences) is retried once. Ids still
    missing after all chunks get one final straggler pass.
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

    # Pass 1: one call per chunk, with one drop/parse retry per chunk.
    leftovers: list[tuple[str, str]] = []
    for chunk in _chunks(pending, TRANSLATE_CHUNK_SIZE):
        leftovers.extend(_translate_chunk(chunk, lang, client, glossary, result, retry=True))

    # Pass 2 (stragglers): one final bounded call per leftover chunk; ids that
    # still fail here just fall back to English (best-effort contract).
    for chunk in _chunks(leftovers, TRANSLATE_CHUNK_SIZE):
        _translate_chunk(chunk, lang, client, glossary, result, retry=False)

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
        raise HTTPException(status_code=400, detail="No filename provided")

    # Resolve the client BEFORE consuming quota: if MISTRAL_API_KEY is missing
    # the request can never succeed, so we must not burn the user's extraction
    # count (anonymous users in particular get locked out after 5 doomed tries).
    client = _get_client()
    if client is None:
        async def error_stream():
            yield _sse("error", {"message": "AI extraction unavailable: MISTRAL_API_KEY not configured. Please add the key to backend/.env or enter data manually."})
        return StreamingResponse(error_stream(), media_type="text/event-stream")

    # Check AI extraction limit. Defer the commit (commit=False) so a request
    # that fails file validation below does not burn the user's extraction
    # count — the commit happens only once the file is known to be usable.
    allowed, current_count, limit = check_and_record_ai_usage(db, user_id, is_anonymous, commit=False)
    if not allowed:
        if is_anonymous:
            detail = (
                f"AI extraction limit reached ({current_count}/{limit}). "
                "Please register for higher limits."
            )
        else:
            detail = (
                f"AI extraction limit reached ({current_count}/{limit}). "
                "Consider upgrading your plan or contact support for a higher limit."
            )
        raise HTTPException(status_code=429, detail=detail)

    try:
        bytes_data = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {e}") from e

    if not bytes_data:
        raise HTTPException(status_code=400, detail="Empty file")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in extractor.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(extractor.ALLOWED_EXTENSIONS))}",
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
                error = ocr_err.message
            elapsed = time.perf_counter() - t0
            logger.info("OCR took %.2fs — %d chars", elapsed, len(markdown) if markdown else 0)

            if not error and not markdown:
                error = "The document was processed but no text content was found. It may contain only images or scanned signatures."

            # Stage 2: LLM extraction
            if not error:
                yield _sse("progress", {"stage": "extracting", "markdown_chars": len(markdown)})
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
                        biomarkers=[],
                        visit_data=StandardizedVisitData(),
                        instrumental_data=RawInstrumentalData(),
                    ).model_dump(),
                )
                return

            # Stage 3: Matching
            yield _sse("progress", {"stage": "matching", "biomarker_count": bm_count})
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

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            # Prevent proxies (nginx, etc.) from buffering the SSE stream so
            # progress events reach the client incrementally instead of all at once.
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
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

    Best-effort: definitions that already carry ``names[lang]`` are returned
    untouched (no LLM call, no quota charge); on LLM failure the request still
    succeeds with the original English names and the charged quota is refunded.
    """
    _user, user_id, is_anonymous = user_data

    if not payload.names:
        return TranslateResponse(translations=[])

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

    if not to_translate:
        # Nothing new to translate: return whatever is already known without
        # burning quota (re-generates of an already-translated document are free).
        return TranslateResponse(
            translations=[
                TranslationItem(
                    id=item.id,
                    name=(
                        (defn_by_id[item.id].names or {}).get(payload.lang)
                        if item.id in defn_by_id
                        else item.name
                    )
                    or item.name,
                )
                for item in payload.names
            ]
        )

    # The LLM call can never succeed without a key, so never charge quota for
    # a request that would have to fall back to English anyway.
    client = _get_client()
    if client is None:
        return TranslateResponse(
            translations=[TranslationItem(id=item.id, name=item.name) for item in payload.names]
        )

    allowed, current_count, limit = check_and_record_ai_usage(db, user_id, is_anonymous, commit=False)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=(
                f"AI translation limit reached ({current_count}/{limit}). "
                "Please register for higher limits."
            ),
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

    unique_items = list({item_id: name for item_id, name in to_translate}.items())
    translated = _translate_names_to_lang(unique_items, payload.lang, client, glossary=glossary)
    if not translated:
        # The LLM failed after the quota increment was flushed: refund it.
        refund_ai_extraction(db, user_id, is_anonymous)
        return TranslateResponse(
            translations=[TranslationItem(id=item.id, name=item.name) for item in payload.names]
        )

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
    db.commit()

    return TranslateResponse(
        translations=[
            TranslationItem(
                id=item.id,
                name=(
                    (defn_by_id[item.id].names or {}).get(payload.lang)
                    if item.id in defn_by_id
                    else item.name
                )
                or item.name,
            )
            for item in payload.names
        ]
    )
