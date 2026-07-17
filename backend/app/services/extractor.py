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

logger = logging.getLogger(__name__)

# Per-call timeout (ms) for the Mistral Files upload + OCR requests, and how
# many times to retry a stalling request. A single healthy request for a large
# phone photo completes in ~15s, so 90s is generous; on a stall the call fails
# fast and we retry rather than hanging the SSE stream indefinitely.
OCR_CALL_TIMEOUT_MS = 90_000
OCR_MAX_ATTEMPTS = 3


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
        return OCRProcessingError(
            "Mistral AI authentication failed (HTTP %s). The MISTRAL_API_KEY in "
            "backend/.env is invalid or expired. Please update it and restart the backend."
            % status,
            kind="auth",
        )
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
    'classify the entry_type as "blood_test", "doctor_visit", "imaging", or "unknown".\n\n'
    "Extract ALL text EXACTLY AS WRITTEN in the source document. "
    "Do NOT translate. Do NOT convert units. Do NOT interpret or standardize values. "
    "Preserve the original language, formatting, and content exactly.\n\n"
    "Extract the date and time of the analysis, visit, or exam. "
    "Output date in ISO format (YYYY-MM-DD). Output time in 24-hour format (HH:mm). "
    "Look for time near the date field, in the document header, or footer.\n\n"
    "Extract the provider (ordering doctor or clinician name) whenever present.\n\n"
    "Notes should contain only clinically relevant information "
    "(diagnoses, findings, recommendations). Do NOT include lab disclaimers, "
    "promotional text, or metadata timestamps in notes.\n\n"
    "For blood tests:\n"
    "- Organize biomarkers into category groups\n"
    "- Include name, value, unit, and reference range string for each biomarker exactly as they appear\n"
    "- Additionally, for each biomarker set 'standard_name_en' to the common English "
    "name of the analyte (e.g. 'Гемоглобин' -> 'Hemoglobin', 'Холестерин' -> 'Cholesterol'). "
    "This is the ONLY field you may translate; keep 'name' exactly as written.\n"
    "- The reference range string is the text after the value/unit, e.g. '< 5.0', '1.32 - 3.57', "
    "'> 100', '< 41', 'Negative', 'Absent', or '0.8-1.2'. "
    "Always extract it even when it's a single-bound format like '< X' or '> X'.\n"
    "- If the range is not next to the biomarker value, look at nearby text, footnotes, "
    "or interpretation notes for the same biomarker. For example, a note like "
    "'Рекомендации по интерпретации: желательный уровень холестерина <5.0 ммоль/л' "
    "means the range for cholesterol is '< 5.0'.\n\n"
    "For doctor visits:\n"
    "- Extract the diagnosis, chief complaint, objective findings\n"
    "- List any prescriptions with name, dosage, and instructions\n\n"
    "For imaging reports:\n"
    "- Extract the modality (MRI, CT, X-Ray, Ultrasound, etc.)\n"
    "- Summarize the findings and conclusion\n\n"
    "Return ONLY valid JSON matching the provided schema. Do not include any text outside the JSON."
)


def _convert_to_pdf(bytes_data: bytes, ext: str) -> Optional[bytes]:
    """Convert an image file to PDF bytes using Pillow. Returns None on failure."""
    try:
        img = Image.open(io.BytesIO(bytes_data)).convert("RGB")
        pdf_bytes = io.BytesIO()
        img.save(pdf_bytes, format="PDF")
        logger.info("Converted %s to PDF (%d → %d bytes)", ext, len(bytes_data), pdf_bytes.tell())
        return pdf_bytes.getvalue()
    except Exception as e:
        logger.warning("Image-to-PDF conversion failed for %s: %s", ext, e)
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
                    model="mistral-ocr-latest",
                    document=FileChunk(file_id=uploaded.id),
                    include_image_base64=False,
                    image_limit=0,
                    timeout_ms=OCR_CALL_TIMEOUT_MS,
                )
                markdown = "\n\n".join(page.markdown for page in ocr_response.pages)
                markdown = re.sub(r'!\[.*?\]\(.*?\)', '', markdown)
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
                    raise _classify_ocr_error(e)
                logger.warning(
                    "OCR attempt %d/%d (candidate=%s) failed: %s",
                    attempt, OCR_MAX_ATTEMPTS, c_name, e,
                )

    raise _classify_ocr_error(last_err)


def _parse_llm_response(result: object, markdown: str) -> RawMedicalRecord:
    if isinstance(result, RawMedicalRecord):
        return result
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
            return RawMedicalRecord(**parsed)
        except (json.JSONDecodeError, Exception) as e:
            logger.error("Failed to parse LLM response as JSON: %s", e)
    return RawMedicalRecord(
        entry_type="unknown",
        notes=f"Raw OCR text:\n\n{markdown[:5000]}",
    )


def llm_extract(markdown: str, client: Mistral) -> RawMedicalRecord:
    """Run LLM extraction on OCR markdown text, returning a RawMedicalRecord."""
    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
            temperature=0,
            messages=[
                {"role": "system", "content": RAW_EXTRACTION_PROMPT},
                {"role": "user", "content": markdown},
            ],
            response_format=RawMedicalRecord,
            max_tokens=16000,
        )
    except Exception as e:
        logger.error("Mistral chat.parse failed: %s", e)
        return RawMedicalRecord(
            entry_type="unknown",
            notes=f"Raw OCR text:\n\n{markdown[:5000]}",
        )

    result = chat_response.choices[0].message.content
    logger.info("LLM raw response: %s", result[:500] if isinstance(result, str) else type(result))
    return _parse_llm_response(result, markdown)


def extract_raw(
    bytes_data: bytes,
    filename: str,
    client: Mistral,
) -> RawMedicalRecord:
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    try:
        markdown = ocr_document(bytes_data, ext, client)
    except OCRProcessingError:
        return RawMedicalRecord(
            entry_type="unknown",
            notes="The uploaded document appears to contain images that cannot be processed. You can enter the data manually below.",
        )
    if not markdown:
        return RawMedicalRecord(
            entry_type="unknown",
            notes="OCR returned no text content",
        )

    return llm_extract(markdown, client)
