import base64
import json
import logging
import os
import re

from mistralai import Mistral
from mistralai.models import DocumentURLChunk

from app.schemas.ai import RawMedicalRecord

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp"}

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


def _ocr_to_markdown(bytes_data: bytes, client: Mistral):
    try:
        b64 = base64.b64encode(bytes_data).decode()
        data_url = f"data:application/pdf;base64,{b64}"
        ocr_response = client.ocr.process(
            model="mistral-ocr-latest",
            document=DocumentURLChunk(document_url=data_url),
            include_image_base64=False,
            image_limit=0,
        )
    except Exception as e:
        err_str = str(e).lower()
        if "not support" in err_str:
            logger.warning("OCR does not support this document format")
            return None
        raise

    markdown = "\n\n".join(page.markdown for page in ocr_response.pages)
    markdown = re.sub(r'!\[.*?\]\(.*?\)', '', markdown)
    return markdown.strip()


def _parse_llm_response(result: object, markdown: str) -> RawMedicalRecord:
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

    markdown = _ocr_to_markdown(bytes_data, client)
    if markdown is None:
        return RawMedicalRecord(
            entry_type="unknown",
            notes="The uploaded document appears to contain images that cannot be processed. You can enter the data manually below.",
        )
    if not markdown:
        return RawMedicalRecord(
            entry_type="unknown",
            notes="OCR returned no text content",
        )

    try:
        chat_response = client.chat.parse(
            model="mistral-large-latest",
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
    return _parse_llm_response(result, markdown)
