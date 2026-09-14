import io
import json
import logging
import os
import re
from typing import Optional

from mistralai import Mistral
from mistralai.models import FileChunk
from mistralai.models.file import File
from PIL import Image

from app.schemas.ai import RawMedicalRecord
from config import MISTRAL_CHAT_MODEL

logger = logging.getLogger(__name__)

# Per-call timeout (ms) for the Mistral Files upload + OCR requests, and how
# many times to retry a stalling request. A single healthy request for a large
# phone photo completes in ~15s, so 90s is generous; on a stall the call fails
# fast and we retry rather than hanging the SSE stream indefinitely.
OCR_CALL_TIMEOUT_MS = 90_000
OCR_MAX_ATTEMPTS = 3
# Reported in benchmark report fingerprints (ISSUES.md F8) and used for the
# OCR request; keep as the single source of truth for the model id.
OCR_MODEL = "mistral-ocr-latest"


class OCRProcessingError(Exception):
    """Raised when Mistral OCR cannot process the document.

    `kind` distinguishes the failure cause so the API can surface an
    actionable message instead of a generic one:
      - "auth":    401/403 — API key invalid/expired (check MISTRAL_API_KEY)
      - "quota":   429    — Mistral OCR quota exhausted
      - "unknown": any other failure (network, unsupported, etc.)
    """

    def __init__(self, message: str, kind: str = "unknown"):
        super().__init__(message)
        self.message = message
        self.kind = kind


class FileTooLargeError(Exception):
    """Raised by :func:`read_capped` when an upload exceeds its size cap."""

    def __init__(self, size: int, cap: int):
        self.size = size
        self.cap = cap
        super().__init__(f"upload is {size} bytes, cap is {cap}")


async def read_capped(file, max_bytes: int) -> bytes:
    """Read an UploadFile capped at ``max_bytes`` (ISSUES.md #53).

    Reads at most ``max_bytes + 1`` bytes, so an oversized upload is
    rejected by its SIZE — the previous unconditional ``await file.read()``
    pulled the whole body into memory (unbounded for a hostile client)
    before any size check ran. Raises :class:`FileTooLargeError` when the
    upload does not fit; callers map that onto their own 413 response."""
    buf = await file.read(max_bytes + 1)
    if len(buf) > max_bytes:
        raise FileTooLargeError(len(buf), max_bytes)
    return buf


def _classify_ocr_error(exc: Exception) -> OCRProcessingError:
    """Map a raw Mistral/OCR exception to a typed, user-facing error.

    Previously any non-auth/non-quota failure (including timeouts and
    oversized uploads) collapsed into a misleading "file type may not be
    supported" message. We now distinguish:
      - "auth":    401/403 — API key invalid/expired (check MISTRAL_API_KEY)
      - "quota":   429    — Mistral OCR quota exhausted
      - "timeout": no HTTP status, connection/read timeout — the document is
                    too large/slow to process (common for big phone photos)
      - "invalid": 400/413/414/422 — rejected (too large or unsupported format)
      - "server":  5xx    — Mistral OCR temporarily unavailable
      - "unknown": anything else (network, unsupported, etc.)
    """
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if status is None:
        m = re.search(r"Status\s+(\d{3})", str(exc))
        if m:
            status = int(m.group(1))

    # Network-level stalls have no HTTP status code. These are the usual cause
    # of very large image uploads hanging — never blame the file type for them.
    if status is None:
        etype = type(exc).__name__
        if "Timeout" in etype or "Connection" in etype or "Read" in etype or "Reset" in etype:
            return OCRProcessingError(
                "The document took too long to process. Try a smaller or lower-resolution "
                "image, or upload a PDF instead.",
                kind="timeout",
            )
        return OCRProcessingError(
            "The uploaded document could not be processed by OCR. The file may be "
            "corrupted or in an unsupported format.",
            kind="unknown",
        )

    if status in (401, 403):
        err = OCRProcessingError(
            f"Mistral AI authentication failed (HTTP {status}). The MISTRAL_API_KEY in "
            "backend/.env is invalid or expired. Please update it and restart the backend.",
            kind="auth",
        )
        # http_status lets the /api/extract stream localize this message per
        # request locale (app/i18n.py) with the concrete HTTP code interpolated.
        err.http_status = status
        return err
    if status == 429:
        return OCRProcessingError(
            "Mistral OCR quota exceeded (HTTP 429). Upgrade your plan or try again later.",
            kind="quota",
        )
    if status in (400, 413, 414, 422):
        return OCRProcessingError(
            "The document could not be processed by OCR. It may be too large or in an "
            "unsupported format. Try a smaller image or a PDF.",
            kind="invalid",
        )
    if 500 <= status < 600:
        return OCRProcessingError(
            "The OCR service is temporarily unavailable. Please try again later.",
            kind="server",
        )
    return OCRProcessingError(
        "The uploaded document could not be processed by OCR. This file type may not be supported.",
        kind="unknown",
    )


class LLMProcessingError(Exception):
    """Raised when the extraction chat call fails in a way that must not be
    swallowed by the silent fallback record.

    ``kind`` mirrors ``OCRProcessingError.kind``: "auth" (401/403), "quota"
    (429), "unknown" (anything else). Both the benchmark and the live
    extraction paths opt in via ``llm_extract(..., raise_on_hard_error=True)``
    so chat auth/quota surface as typed failures (benchmark exit 2; SSE and
    batch import localize/refund) instead of degrading into the fallback
    record (ISSUES.md F11).
    """

    def __init__(self, message: str, kind: str = "unknown"):
        super().__init__(message)
        self.message = message
        self.kind = kind


def _classify_chat_error(exc: Exception) -> LLMProcessingError:
    """Map a raw chat/extraction exception to a typed error.

    Recognizes both the Mistral SDK shape (``status_code``/``status``) and the
    OpenRouter wrapper's ``RuntimeError("OpenRouter HTTP <code>: ...")`` text.
    """
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if status is None:
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
    if status is None:
        m = re.search(r"(?:Status|HTTP)\s+(\d{3})", str(exc))
        if m:
            status = int(m.group(1))

    if status in (401, 403):
        err = LLMProcessingError(
            f"AI extraction authentication failed (HTTP {status}). The MISTRAL_API_KEY "
            "in backend/.env is invalid or expired. Please update it and restart the backend.",
            kind="auth",
        )
        err.http_status = status
        return err
    if status == 429:
        return LLMProcessingError(
            "AI extraction quota exceeded (HTTP 429). Upgrade your plan or try again later.",
            kind="quota",
        )
    return LLMProcessingError(
        f"AI extraction failed: {exc}",
        kind="unknown",
    )


ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp"}

MIME_MAP = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".bmp": "image/bmp",
}

RAW_EXTRACTION_PROMPT = (
    "You are a medical data extraction assistant. Given OCR output of a medical document, "
    'classify the entry_type as "blood_test", "doctor_visit", "instrumental_test", or "unknown".\n\n'
    "Also determine the specimen (the material being tested): set the "
    "record-level 'specimen' to the document's MAIN material — 'blood' for a "
    "blood/serum/plasma panel (even when it also contains a single urine or "
    "stool test), 'urine' for a urinalysis document (e.g. titled «Общий анализ "
    "мочи»), 'feces' for a stool analysis document, 'other', or 'unknown' when "
    "the document does not say. For each biomarker whose material differs from "
    "the record-level one (e.g. an «Анализ кала» row inside a blood panel), set "
    "that row's 'specimen' to the row's material; otherwise leave the row's "
    "specimen empty.\n\n"
    "Extract ALL text EXACTLY AS WRITTEN in the source document. "
    "Do NOT translate. Do NOT convert units. Do NOT interpret or standardize values. "
    "Preserve the original language, formatting, and content exactly.\n\n"
    "Extract the date and time of the event. For blood tests, prefer the date "
    "when the blood/biomaterial sample was taken (collection date); only fall "
    "back to the report/results date when no collection date is shown. For "
    "visits and instrumental exams, use the date of the visit or exam. "
    "Output date in ISO format (YYYY-MM-DD). Output time in 24-hour format (HH:mm), "
    "and only when a time is shown next to that same collection/visit/exam date — "
    "otherwise leave time empty. "
    "Look for time near the date field, in the document header, or footer. "
    "A sample RECEIPT/accession timestamp (e.g. «дата поступления», «пробы "
    "приняты») is NOT the collection time — only a time printed together with "
    "the collection/visit/exam date itself counts; otherwise leave time empty.\n\n"
    "Extract the provider: the doctor or clinician who signed or certified the "
    "document — look for the signature block (e.g. «заведующий» / head of "
    "laboratory / attending physician next to a signature). Prefer the "
    "signing/certifying clinician over the test performer («Исполнитель»); if "
    "only an ordering/referring doctor is printed, use that. The patient is "
    "NEVER the provider: the person named at the top of a lab report (the one "
    "the results belong to, next to sex / birth date / patient id) must never "
    "be copied into provider. Leave provider empty if no doctor or clinician "
    "is printed.\n\n"
    "Notes should contain only clinically relevant information "
    "(diagnoses, findings, recommendations). Do NOT include lab disclaimers, "
    "promotional text, or metadata timestamps in notes.\n\n"
    "For blood tests:\n"
    "- Organize biomarkers into category groups\n"
    "- Leave visit_data empty for blood tests: a laboratory report has no "
    "diagnosis / chief complaint / prescriptions / recommendations sections. "
    "A per-analyte «Комментарий» column is not a recommendation.\n"
    "- Include name, value, unit, and reference range string for each biomarker exactly as they appear\n"
    "- Additionally, for each biomarker set 'standard_name_en' to the common English "
    "name of the analyte (e.g. 'Гемоглобин' -> 'Hemoglobin', 'Холестерин' -> 'Cholesterol'). "
    "This is the ONLY field you may translate; keep 'name' exactly as written.\n"
    "- The reference range string is the text after the value/unit, e.g. '< 5.0', '1.32 - 3.57', "
    "'> 100', '< 41', 'Negative', 'Absent', or '0.8-1.2'. "
    "Always extract it even when it's a single-bound format like '< X' or '> X'.\n"
    "- Never leave the reference empty because it repeats the expected result: "
    "a qualitative test often re-prints the same word in the reference cell as "
    "the result (e.g. result «отрицательный» and reference «отрицательный»; "
    "extract raw_range_string «отрицательный»).\n"
    "- If the range is not next to the biomarker value, look at nearby text, footnotes, "
    "or interpretation notes for the same biomarker. For example, a note like "
    "'Рекомендации по интерпретации: желательный уровень холестерина <5.0 ммоль/л' "
    "means the range for cholesterol is '< 5.0'.\n\n"
    "For doctor visits:\n"
    "- Extract the diagnosis, chief complaint, objective findings\n"
    "- List any prescriptions with name, dosage, and instructions\n"
    "- Recommendations: follow the report's own numbered structure. Each "
    "numbered point ('1.', '2.', ...) becomes one item verbatim start-to-end, "
    "KEEPING its section heading when printed (e.g. 'Лабораторная и "
    "инструментальная диагностика: Общий анализ крови; Биохимический анализ "
    "крови: ...') — short dash-bullet test enumerations under that heading stay "
    "INLINE after it, separated by ';'. Include EVERY numbered item exactly "
    "once and in the printed order; never omit the last item — a missing "
    "recommendation is unrecoverable data loss downstream. EXCEPTION: a "
    "dash-bullet that is a "
    "substantive standalone referral/action — multiple sentences, its own "
    "instructions, addresses, phones or emails (e.g. 'Экспертный пересмотр "
    "гистологических препаратов в консультативном центре ...') — is emitted as "
    "its OWN separate recommendation immediately after the item it belongs to, "
    "without copying that heading onto itself.\n\n"
    "For instrumental test reports (imaging, elastography, endoscopy, ECG, spirometry, etc.):\n"
    "- Extract the modality — choose exactly ONE from this fixed list: "
    "MRI, CT, X-Ray, Ultrasound, Elastography, Mammography, PET Scan, ECG, Endoscopy, Other\n"
    "- Put the report content in findings and the conclusion in conclusion\n"
    "- findings must contain ONLY the clinical report body (the organ/measurement "
    "lines): never the patient demographics (Ф.И.О name, age, sex), the examination "
    "date, the equipment/scanner name, the document title, or the clinic header/footer "
    "boilerplate\n"
    "- Put only the conclusion text in conclusion, without the printed section label "
    "(no leading «Заключение:»)\n"
    "- Leave notes empty for instrumental test reports (the content belongs in findings/conclusion)\n"
    "- Leave visit_data empty for instrumental test reports: a diagnostic report has no "
    "diagnosis / chief complaint / prescriptions / recommendations sections. A printed "
    "«Рекомендации:» line is not visit data either — omit it.\n\n"
    "Return ONLY valid JSON matching the provided schema. Do not include any text outside the JSON."
)


_PAGE_FURNITURE_RE = re.compile(
    r"^(?:стр\.\s*\d+\s*из\s*\d+|page\s+\d+(?:\s*/\s*\d+)?|[-=_*]{3,}"
    r"|продолжение на следующей странице|continued on (?:the )?next page)\s*$",
    re.IGNORECASE,
)
_TABLE_SEPARATOR_RE = re.compile(r"^\|(\s*:?-+:?\s*\|)+\s*$")
_URL_RE = re.compile(r"^(?:https?://|www\.)\S+$", re.IGNORECASE)


def _clean_ocr_markdown(markdown: str) -> str:
    """Deterministically strip zero-information boilerplate from OCR markdown
    before it is sent to any LLM (extraction or matching).

    Removes only noise that cannot affect extraction semantics:
    - table separator rows (``| --- | --- |``): pure rendering artifacts;
    - page furniture (``стр.1 из 2``, ``Page 3``, ``---`` rules);
    - standalone URL lines;
    - EXACT duplicate non-tabular lines (headers/footers/legal blocks repeat
      on every page) — keep-first, so no information is ever lost; biomarker
      rows (starting with ``|``) are never deduped;
    - runs of blank lines.

    Clinical content — table rows, headings, notes, dates — is untouched.
    """
    lines_out: list[str] = []
    seen_non_tabular: set[str] = set()
    for raw_line in markdown.split("\n"):
        line = raw_line.rstrip()
        stripped = line.strip()
        if (not stripped or _TABLE_SEPARATOR_RE.match(stripped)
                or _PAGE_FURNITURE_RE.match(stripped) or _URL_RE.match(stripped)):
            continue
        # Header/footer/legal blocks repeat verbatim on every page. Dedupe
        # keep-first; tabular rows carry real data and are exempt.
        if (not stripped.startswith("|") and len(stripped) < 120
                and stripped in seen_non_tabular):
            continue
        if not stripped.startswith("|") and len(stripped) < 120:
            seen_non_tabular.add(stripped)
        lines_out.append(line)
    cleaned = "\n".join(lines_out)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _convert_to_pdf(bytes_data: bytes, ext: str) -> Optional[bytes]:
    """Convert an image file to PDF bytes using Pillow. Returns None on failure."""
    try:
        img = Image.open(io.BytesIO(bytes_data)).convert("RGB")
        pdf_bytes = io.BytesIO()
        img.save(pdf_bytes, format="PDF")
        logger.info("Converted %s to PDF (%d → %d bytes)", ext, len(bytes_data), pdf_bytes.tell())
        return pdf_bytes.getvalue()
    except Exception as e:
        logger.warning("Image-to-PDF conversion failed for %s: %s", ext, e, exc_info=True)
        return None


def ocr_document(bytes_data: bytes, ext: str, client: Mistral) -> str:
    """Run OCR on the document bytes and return markdown text.

    Uploads the document to Mistral's Files API (``purpose="ocr"``) and runs
    OCR by file id, instead of embedding the whole file as a base64 data URL.
    This avoids the ~33% base64 size inflation that made large image uploads
    slow or hang (see the doctor-visit photo regression). Images are converted
    to PDF first since Mistral OCR handles PDFs more reliably than raw image
    data URLs; the raw image bytes are used as a fallback if conversion fails
    or the converted-PDF path keeps stalling.

    The upload + OCR calls use a bounded per-call timeout (see ``OCR_CALL_TIMEOUT_MS``)
    and are retried a few times, because the Mistral Files endpoint intermittently
    stalls on large uploads — without this, a single stuck request would hang the
    whole SSE stream. Auth/quota failures are not retried.

    Raises OCRProcessingError when OCR processing fails.
    """
    # Candidate payloads to try, in order of preference.
    candidates = []
    if ext in MIME_MAP and ext != ".pdf":
        pdf_data = _convert_to_pdf(bytes_data, ext)
        if pdf_data is not None:
            candidates.append((pdf_data, "document.pdf", "application/pdf"))
        candidates.append((bytes_data, f"document{ext}", MIME_MAP[ext]))
    else:
        candidates.append((bytes_data, "document.pdf", MIME_MAP.get(ext, "application/pdf")))

    last_err: Optional[Exception] = None
    for c_bytes, c_name, c_mime in candidates:
        for attempt in range(1, OCR_MAX_ATTEMPTS + 1):
            try:
                uploaded = client.files.upload(
                    file=File(fileName=c_name, content=c_bytes, content_type=c_mime),
                    purpose="ocr",
                    timeout_ms=OCR_CALL_TIMEOUT_MS,
                )
                ocr_response = client.ocr.process(
                    model=OCR_MODEL,
                    document=FileChunk(file_id=uploaded.id),
                    include_image_base64=False,
                    image_limit=0,
                    timeout_ms=OCR_CALL_TIMEOUT_MS,
                )
                markdown = "\n\n".join(page.markdown for page in ocr_response.pages)
                markdown = re.sub(r'!\[.*?\]\(.*?\)', '', markdown)
                # Deterministic boilerplate strip (input-token compression).
                # OCR_MARKDOWN_CLEAN=0 disables it — the loop's A/B switch for
                # measuring the cleaner's quality/token effect.
                if os.getenv("OCR_MARKDOWN_CLEAN", "1") != "0":
                    markdown = _clean_ocr_markdown(markdown)
                markdown = markdown.strip()
                logger.info(
                    "OCR returned %d pages, %d chars (candidate=%s, attempt=%d)",
                    len(ocr_response.pages), len(markdown), c_name, attempt,
                )
                return markdown
            except Exception as e:
                last_err = e
                kind = _classify_ocr_error(e).kind
                # Auth/quota will never succeed on retry — fail fast.
                if kind in ("auth", "quota"):
                    raise _classify_ocr_error(e) from e
                logger.warning(
                    "OCR attempt %d/%d (candidate=%s) failed: %s",
                    attempt, OCR_MAX_ATTEMPTS, c_name, e,
                    exc_info=True,
                )

    raise _classify_ocr_error(last_err)


class _LLMResponseParseError(Exception):
    """The extraction call returned something that is not a RawMedicalRecord."""


def _unknown_fallback(markdown: str) -> RawMedicalRecord:
    """The silent degraded record: entry_type "unknown" carrying the OCR text.

    Only reachable when the LLM call itself could not be completed — a valid
    call that genuinely yields a non-medical document also returns
    ``entry_type="unknown"`` but is a SUCCESS (no refund, unknown-editor).
    """
    return RawMedicalRecord(
        entry_type="unknown",
        notes=f"Raw OCR text:\n\n{markdown[:5000]}",
    )


def _parse_llm_response(result: object) -> RawMedicalRecord:
    if isinstance(result, RawMedicalRecord):
        return result
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
            return RawMedicalRecord(**parsed)
        except Exception as e:
            raise _LLMResponseParseError(str(e)) from e
    raise _LLMResponseParseError(f"unexpected LLM response type: {type(result).__name__}")


_ANTI_PREFIX_RE = re.compile(r"^\s*anti\s*[-–]\s*", re.IGNORECASE)


def _preserve_antibody_prefix(record: RawMedicalRecord) -> RawMedicalRecord:
    """Restore the ``anti-`` prefix the source analyte name carries.

    The extraction LLM drops the prefix ("anti-Opisthorchis IgG" ->
    "Opisthorchis IgG") and also varies its casing between runs
    ("Anti-Giardia" vs "anti-Giardia"). For locally-defined serology rows that
    English string becomes the stored analyte name, so both the loss and the
    case flip surface as name diffs against hand-verified goldens (which use
    the lowercase form for lowercase sources). Deterministic and idempotent;
    leaves non-antibody names alone.
    """
    for b in record.biomarkers or []:
        if not _ANTI_PREFIX_RE.match(b.name or ""):
            continue
        en = (b.standard_name_en or "").strip()
        if not en:
            continue
        b.standard_name_en = "anti-" + _ANTI_PREFIX_RE.sub("", en, count=1).strip()
    return record


def llm_extract(markdown: str, client: Mistral, *,
                raise_on_hard_error: bool = False) -> RawMedicalRecord:
    """Run LLM extraction on OCR markdown text, returning a RawMedicalRecord.

    ``raise_on_hard_error`` makes auth/quota chat failures raise
    :class:`LLMProcessingError` instead of degrading into the silent
    "unknown + Raw OCR text" fallback record: the benchmark maps them to its
    hard-failure exit (ISSUES.md F11), the SSE stream localizes them, and the
    batch worker stores a typed error key. Other provider errors keep the
    fallback behavior in both modes.

    A doctor_visit extraction that omits a numbered recommendation printed in
    the source gets ONE bounded retry with a correction hint (small models
    intermittently renumber the standalone referral as the next item and drop
    the real one). The retry only wins when it is strictly more complete.
    """
    try:
        record = _extraction_call(markdown, client)
    except _LLMResponseParseError as e:
        # Model JSON flakiness is usually transient — retry the call once
        # before degrading to the silent "unknown" fallback record.
        logger.error("Failed to parse LLM response as JSON: %s", e, exc_info=True)
        try:
            record = _extraction_call(markdown, client)
        except _LLMResponseParseError as retry_err:
            logger.error("Failed to parse LLM response on retry: %s", retry_err, exc_info=True)
            return _unknown_fallback(markdown)
        except Exception as retry_exc:
            classified = _classify_chat_error(retry_exc)
            if raise_on_hard_error and classified.kind in ("auth", "quota"):
                raise classified from retry_exc
            logger.error("Mistral chat.parse failed on retry: %s", retry_exc, exc_info=True)
            return _unknown_fallback(markdown)
    except Exception as e:
        classified = _classify_chat_error(e)
        if raise_on_hard_error and classified.kind in ("auth", "quota"):
            raise classified from e
        logger.error("Mistral chat.parse failed: %s", e, exc_info=True)
        return _unknown_fallback(markdown)

    missing = _missing_numbered_leads(markdown, record)
    if missing:
        correction = (
            "Your previous extraction omitted numbered recommendation(s): "
            + "; ".join(f'"{m}"' for m in missing[:5])
            + ". Return the complete JSON again, including EVERY numbered item "
            "verbatim and in the printed order."
        )
        try:
            retry = _extraction_call(markdown, client, correction=correction)
        except Exception as e:
            logger.warning("Recommendation-completeness retry failed: %s", e, exc_info=True)
            retry = None
        if retry is not None and len(_missing_numbered_leads(markdown, retry)) < len(missing):
            logger.info(
                "Recommendation-completeness retry recovered %d item(s)",
                len(missing) - len(_missing_numbered_leads(markdown, retry)),
            )
            return retry
        logger.info("Recommendation-completeness retry did not improve; keeping first result")
    return record


def _extraction_call(markdown: str, client: Mistral,
                     correction: str = "") -> RawMedicalRecord:
    """One chat.parse extraction call (optionally with a correction hint)."""
    messages = [
        {"role": "system", "content": RAW_EXTRACTION_PROMPT},
        {"role": "user", "content": markdown},
    ]
    if correction:
        messages.append({"role": "user", "content": correction})
    chat_response = client.chat.parse(
        model=MISTRAL_CHAT_MODEL,
        temperature=0,
        messages=messages,
        response_format=RawMedicalRecord,
        max_tokens=16000,
    )
    result = chat_response.choices[0].message.content
    logger.info("LLM raw response: %d chars", len(result) if isinstance(result, str) else 0)
    return _preserve_antibody_prefix(_parse_llm_response(result))


_NUMBERED_ITEM_RE = re.compile(r"^\s*\d{1,2}[.)]\s+(\S[^\n]*)", re.MULTILINE)


def _normalize_lead(text: str) -> str:
    return re.sub(r"[^0-9a-zа-яё]+", " ", text.casefold()).strip()


def _missing_numbered_leads(markdown: str, record: RawMedicalRecord) -> list[str]:
    """Numbered recommendation leads printed in the source but absent from a
    doctor_visit extraction (tolerant lead-text comparison).

    Only called for doctor_visit records that carry at least one
    recommendation, so numbered lists in lab reports never trigger a retry.
    """
    if record.entry_type != "doctor_visit":
        return []
    recs = (record.visit_data.recommendations if record.visit_data else []) or []
    if not recs:
        return []
    rec_norms = [_normalize_lead(r) for r in recs]
    missing: list[str] = []
    for match in _NUMBERED_ITEM_RE.finditer(markdown):
        lead = _normalize_lead(match.group(1))[:40]
        if not lead:
            continue
        if not any(lead in rn for rn in rec_norms):
            missing.append(match.group(1).strip())
    return missing
