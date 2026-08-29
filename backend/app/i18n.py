"""Minimal EN/RU localization for user-facing backend strings.

How it works
------------
- A pure-ASGI middleware (mounted in ``app.main``) parses the request's
  ``Accept-Language`` header once per request and stores the resolved locale
  (``"en"`` or ``"ru"``) in a ContextVar. Everything that runs inside the
  request task — endpoint coroutines, sync endpoints via starlette's context-
  copying threadpool, and the SSE ``event_stream`` generator — sees the same
  value through ``current_locale()``.
- ``i18n.tr(key, **kwargs)`` looks the key up in ``MESSAGES`` and formats it.
  Unknown locales fall back to the English text; a missing key raises
  ``KeyError`` (programmer error, caught by tests). ``tr_opt`` returns ``None``
  for unknown keys (used where messages are built from dynamic kinds).
- The English strings in ``MESSAGES`` are the exact strings that were
  hardcoded before localization — with no ``Accept-Language`` header the API
  behaves byte-for-byte as before (asserted by the existing test suite).

NOTE for ``app/api/ai.py``: a local variable named ``tr`` already exists there;
call sites use the module-qualified ``i18n.tr`` form to avoid shadowing.
"""

from __future__ import annotations

from contextvars import ContextVar

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

_current_locale: ContextVar[str] = ContextVar("current_locale", default="en")

SUPPORTED_LOCALES = ("en", "ru")
DEFAULT_LOCALE = "en"


def resolve_locale(accept_language: str | None) -> str:
    """Pick the best supported locale from an Accept-Language header value.

    Respects q-values; ties and unsupported tags fall back to English.
    ``resolve_locale(None)`` -> ``"en"``.
    """
    if not accept_language:
        return DEFAULT_LOCALE
    candidates: list[tuple[float, int, str]] = []
    for i, part in enumerate(accept_language.split(",")):
        tag, _, q = part.partition(";")
        tag = tag.strip().lower()
        if not tag:
            continue
        if tag == "*":
            continue
        q_value = 1.0
        q = q.strip()
        if q.startswith("q="):
            try:
                q_value = float(q[2:])
            except ValueError:
                q_value = 0.0
        if q_value <= 0:
            # RFC 9110: q=0 means "not acceptable".
            continue
        base = tag.split("-")[0]
        if base in SUPPORTED_LOCALES:
            candidates.append((q_value, -i, base))
    if not candidates:
        return DEFAULT_LOCALE
    candidates.sort(reverse=True)
    return candidates[0][2]


def current_locale() -> str:
    return _current_locale.get()


class LocaleMiddleware:
    """Pure-ASGI middleware: resolve Accept-Language once per request into the
    locale ContextVar. Pure ASGI (not BaseHTTPMiddleware) so SSE streaming is
    untouched, and the endpoint coroutine runs inside this context."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        token = _current_locale.set(resolve_locale(headers.get("accept-language")))
        try:
            await self.app(scope, receive, send)
        finally:
            _current_locale.reset(token)


def tr(key: str, **kwargs: object) -> str:
    """Translate ``key`` for the current request locale (EN fallback)."""
    entry = MESSAGES[key]
    template = entry.get(current_locale()) or entry["en"]
    if kwargs:
        return template.format(**kwargs)
    return template


def tr_opt(key: str, **kwargs: object) -> str | None:
    """Like :func:`tr` but returns ``None`` when the key is unknown."""
    entry = MESSAGES.get(key)
    if entry is None:
        return None
    template = entry.get(current_locale()) or entry["en"]
    if kwargs:
        return template.format(**kwargs)
    return template


MESSAGES: dict[str, dict[str, str]] = {
    # ----- app/api/auth.py -----
    "auth.not_authenticated": {
        "en": "Not authenticated",
        "ru": "Не аутентифицирован",
    },
    "auth.token_expired": {
        "en": "Token expired",
        "ru": "Срок действия токена истёк",
    },
    "auth.invalid_credentials": {
        "en": "Invalid authentication credentials",
        "ru": "Недействительные учётные данные",
    },
    "auth.user_not_found": {
        "en": "User not found",
        "ru": "Пользователь не найден",
    },
    "auth.password_too_short": {
        "en": "Password must be at least {min_length} characters",
        "ru": "Пароль должен содержать не менее {min_length} символов",
    },
    "auth.email_already_registered": {
        "en": "Email already registered",
        "ru": "Этот email уже зарегистрирован",
    },
    "auth.incorrect_email_or_password": {
        "en": "Incorrect email or password",
        "ru": "Неверный email или пароль",
    },
    "auth.too_many_reset_requests": {
        "en": "Too many reset requests. Try again later.",
        "ru": "Слишком много запросов на сброс пароля. Попробуйте позже.",
    },
    "auth.invalid_reset_token": {
        "en": "Invalid or expired reset token",
        "ru": "Недействительная или устаревшая ссылка сброса пароля",
    },
    "auth.message_reset_sent": {
        "en": "If an account exists for this email, a reset link has been sent.",
        "ru": "Если аккаунт с таким email существует, письмо со ссылкой для сброса пароля отправлено.",
    },
    "auth.message_password_updated": {
        "en": "Password updated. You can now sign in with your new password.",
        "ru": "Пароль обновлён. Теперь вы можете войти с новым паролем.",
    },
    # ----- app/api/entries.py -----
    "entries.file_too_large": {
        "en": "File too large ({kb} KB). Maximum allowed size is {max_mb} MB.",
        "ru": "Файл слишком большой ({kb} КБ). Максимально допустимый размер — {max_mb} МБ.",
    },
    "entries.storage_limit_reached": {
        "en": "Storage limit reached. {tier} users can upload up to {limit_mb}MB. Please remove old entries or contact support.",
        "ru": "Достигнут лимит хранилища. {tier} доступно до {limit_mb} МБ. Удалите старые записи или обратитесь в поддержку.",
    },
    "entries.tier_anonymous": {
        "en": "Anonymous",
        "ru": "анонимным пользователям",
    },
    "entries.tier_registered": {
        "en": "Registered",
        "ru": "зарегистрированным пользователям",
    },
    "entries.invalid_date_format": {
        "en": "Invalid date format: '{date}'. Expected ISO format (YYYY-MM-DD).",
        "ru": "Неверный формат даты: '{date}'. Ожидается формат ISO (ГГГГ-ММ-ДД).",
    },
    "entries.invalid_datetime_format": {
        "en": "Invalid date/time format: {error}",
        "ru": "Неверный формат даты/времени: {error}",
    },
    "entries.date_in_future": {
        "en": "Date cannot be in the future",
        "ru": "Дата не может быть в будущем",
    },
    "entries.invalid_biomarkers_json": {
        "en": "Invalid biomarkers JSON format.",
        "ru": "Неверный формат JSON биомаркеров.",
    },
    "entries.invalid_visit_data_json": {
        "en": "Invalid visit_data JSON: {error}",
        "ru": "Неверный JSON visit_data: {error}",
    },
    "entries.visit_data_not_object": {
        "en": "visit_data must be a JSON object",
        "ru": "visit_data должен быть JSON-объектом",
    },
    "entries.invalid_instrumental_data_json": {
        "en": "Invalid instrumental_data JSON: {error}",
        "ru": "Неверный JSON instrumental_data: {error}",
    },
    "entries.instrumental_data_not_object": {
        "en": "instrumental_data must be a JSON object",
        "ru": "instrumental_data должен быть JSON-объектом",
    },
    "entries.entry_not_found": {
        "en": "Entry '{entry_id}' not found",
        "ru": "Запись '{entry_id}' не найдена",
    },
    "entries.merge_only_blood_test": {
        "en": "Only blood test entries can be merged into",
        "ru": "Объединять можно только записи с анализами крови",
    },
    "entries.merge_date_mismatch": {
        "en": "Entry date does not match the supplied merge date",
        "ru": "Дата записи не совпадает с указанной датой объединения",
    },
    "entries.merge_conflict": {
        "en": "Cannot merge: biomarker(s) already present in this test: ",
        "ru": "Невозможно объединить: эти биомаркеры уже есть в данном анализе: ",
    },
    "entries.message_entry_saved": {
        "en": "Entry saved",
        "ru": "Запись сохранена",
    },
    "entries.message_entry_merged": {
        "en": "Entry merged",
        "ru": "Записи объединены",
    },
    # ----- app/api/ai.py -----
    "ai.no_filename": {
        "en": "No filename provided",
        "ru": "Файл не выбран",
    },
    "ai.extraction_limit_anon": {
        "en": "AI extraction limit reached ({current}/{limit}). Please register for higher limits.",
        "ru": "Достигнут лимит AI-распознавания ({current}/{limit}). Зарегистрируйтесь, чтобы увеличить лимит.",
    },
    "ai.extraction_limit_registered": {
        "en": "AI extraction limit reached ({current}/{limit}). Consider upgrading your plan or contact support for a higher limit.",
        "ru": "Достигнут лимит AI-распознавания ({current}/{limit}). Рассмотрите возможность обновления тарифа или обратитесь в поддержку для увеличения лимита.",
    },
    "ai.read_file_failed": {
        "en": "Failed to read file: {error}",
        "ru": "Не удалось прочитать файл: {error}",
    },
    "ai.empty_file": {
        "en": "Empty file",
        "ru": "Пустой файл",
    },
    "ai.unsupported_file_type": {
        "en": "Unsupported file type '{ext}'. Allowed: {allowed}",
        "ru": "Неподдерживаемый тип файла '{ext}'. Разрешено: {allowed}",
    },
    "ai.translation_limit_reached": {
        "en": "AI translation limit reached ({current}/{limit}). Please register for higher limits.",
        "ru": "Достигнут лимит AI-перевода ({current}/{limit}). Зарегистрируйтесь, чтобы увеличить лимит.",
    },
    "ai.auth_required_persist": {
        "en": "Authentication required to persist translations.",
        "ru": "Для сохранения переводов требуется вход в аккаунт.",
    },
    # SSE error messages (event: error -> {"message": ...})
    "ai.sse_no_mistral_key": {
        "en": "AI extraction unavailable: MISTRAL_API_KEY not configured. Please add the key to backend/.env or enter data manually.",
        "ru": "AI-распознавание недоступно: ключ MISTRAL_API_KEY не настроен. Добавьте ключ в backend/.env или введите данные вручную.",
    },
    "ai.sse_no_text": {
        "en": "The document was processed but no text content was found. It may contain only images or scanned signatures.",
        "ru": "Документ обработан, но текст не найден. Возможно, он содержит только изображения или подписи.",
    },
    # OCR error kinds (app/services/extractor.py) — localized in ai.py via
    # OCRProcessingError.kind because classification runs in an executor thread
    # where the locale ContextVar is not visible.
    "ai.ocr_timeout": {
        "en": "The document took too long to process. Try a smaller or lower-resolution image, or upload a PDF instead.",
        "ru": "Обработка документа заняла слишком много времени. Попробуйте изображение меньшего размера или разрешения либо загрузите PDF.",
    },
    "ai.ocr_unknown": {
        "en": "The uploaded document could not be processed by OCR. The file may be corrupted or in an unsupported format.",
        "ru": "Не удалось распознать документ (OCR). Возможно, файл повреждён или имеет неподдерживаемый формат.",
    },
    "ai.ocr_auth": {
        "en": "Mistral AI authentication failed (HTTP {status}). The MISTRAL_API_KEY in backend/.env is invalid or expired. Please update it and restart the backend.",
        "ru": "Ошибка аутентификации Mistral AI (HTTP {status}). Ключ MISTRAL_API_KEY в backend/.env недействителен или его срок истёк. Обновите ключ и перезапустите сервер.",
    },
    "ai.ocr_quota": {
        "en": "Mistral OCR quota exceeded (HTTP 429). Upgrade your plan or try again later.",
        "ru": "Исчерпана квота Mistral OCR (HTTP 429). Обновите тариф или попробуйте позже.",
    },
    "ai.ocr_invalid": {
        "en": "The document could not be processed by OCR. It may be too large or in an unsupported format. Try a smaller image or a PDF.",
        "ru": "Не удалось распознать документ (OCR). Возможно, он слишком велик или имеет неподдерживаемый формат. Попробуйте изображение поменьше или PDF.",
    },
    "ai.ocr_server": {
        "en": "The OCR service is temporarily unavailable. Please try again later.",
        "ru": "Сервис распознавания временно недоступен. Попробуйте позже.",
    },
    "ai.ocr_unsupported": {
        "en": "The uploaded document could not be processed by OCR. This file type may not be supported.",
        "ru": "Не удалось распознать документ (OCR). Возможно, этот тип файла не поддерживается.",
    },
    # ----- app/api/timeline.py -----
    "timeline.biomarker_not_found": {
        "en": "Biomarker '{id}' not found",
        "ru": "Биомаркер '{id}' не найден",
    },
    "timeline.visit_not_found": {
        "en": "Visit '{id}' not found",
        "ru": "Визит '{id}' не найден",
    },
    # ----- app/main.py -----
    "main.forbidden": {
        "en": "Forbidden",
        "ru": "Доступ запрещён",
    },
    "main.file_not_found": {
        "en": "File not found",
        "ru": "Файл не найден",
    },
}
