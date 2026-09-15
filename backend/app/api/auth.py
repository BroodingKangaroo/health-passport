"""
Authentication API routes for HealthPassport.
Handles registration, login, current user info, and password reset.
"""

import hashlib
import logging
import secrets
import threading
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Request,
    Response,
    status,
)
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jwt import ExpiredSignatureError
from pydantic import BaseModel, EmailStr
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import i18n
from app.auth import (
    TOKEN_VERSION_CLAIM,
    authenticate_user,
    bump_token_version,
    create_user,
    decode_token,
    get_password_hash,
    get_user_by_email,
    issue_access_token,
    normalize_email,
    verify_password,
)
from app.db import models
from app.db.session import get_db
from app.logging_setup import set_log_user
from app.services.data_migration import copy_anonymous_data
from app.services.mailer import (
    deliver,
    email_delivery_enabled,
    send_email_change_email,
    send_email_change_notice,
    send_email_change_squatted_notice,
    send_reset_email,
)
from app.services.upload_cleanup import unlink_unreferenced_files
from config import ANONYMOUS_COOKIE_NAME, FRONTEND_URL

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

PASSWORD_MIN_LENGTH = 8
# bcrypt silently truncates at 72 BYTES — a longer input would make two
# different passwords hash identically. The cap is in bytes (not chars):
# multibyte input can exceed it at well under 72 characters.
PASSWORD_MAX_BYTES = 72


def _validate_password_length(password: str) -> None:
    """Reject passwords outside the bcrypt-safe range with a localized 400."""
    if len(password) < PASSWORD_MIN_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.password_too_short", min_length=PASSWORD_MIN_LENGTH),
        )
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.password_too_long", max_bytes=PASSWORD_MAX_BYTES),
        )


class ReauthRequiredError(HTTPException):
    """Marker base class: the request's token IS present but is no longer
    usable, so the caller must re-authenticate. ``get_current_user_or_anon``
    re-raises these instead of degrading to an anonymous session — detection
    is typed, never a string compare on a localized detail (ISSUES.md #52)."""


class TokenExpiredError(ReauthRequiredError):
    """The token's ``exp`` has passed."""


class TokenStaleError(ReauthRequiredError):
    """The token was superseded by a session-version bump: the account's
    password or login address changed after this token was issued, so an
    attacker holding a copy must not keep a session (roadmap 0.4)."""


class UserCreate(BaseModel):
    email: EmailStr
    password: str
    name: str
    dob: str = ""
    gender: str = ""


class UserResponse(BaseModel):
    id: str
    email: str
    name: str
    dob: str = ""
    gender: str = ""
    external_id: str

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    access_token: str
    token_type: str


async def get_current_user(token: Optional[str] = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> models.Patient:
    """Get current authenticated user from JWT token."""
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=i18n.tr("auth.not_authenticated"),
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = decode_token(token)
    except ExpiredSignatureError:
        # Surface expiry distinctly so the frontend can prompt a re-login
        # rather than silently falling back to an empty anonymous session.
        raise TokenExpiredError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=i18n.tr("auth.token_expired"),
            headers={"WWW-Authenticate": "Bearer"},
        ) from None
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=i18n.tr("auth.invalid_credentials"),
            headers={"WWW-Authenticate": "Bearer"},
        )
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=i18n.tr("auth.invalid_credentials"),
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = db.query(models.Patient).filter(models.Patient.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=i18n.tr("auth.user_not_found"),
            headers={"WWW-Authenticate": "Bearer"},
        )
    # Session version: a token minted before the account's password/login
    # address changed is dead. Tokens predating the claim read as 0, which is
    # the column default — so they stay valid until the next bump, exactly the
    # pre-migration behaviour, instead of logging every user out on deploy.
    if payload.get(TOKEN_VERSION_CLAIM, 0) != (user.token_version or 0):
        raise TokenStaleError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=i18n.tr("auth.session_invalidated"),
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


async def get_current_user_or_anon(
    request: Request,
    response: Response,
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> tuple[Optional[models.Patient], str, bool]:
    """
    Get current user (authenticated or anonymous).
    
    Returns: (user_object, user_id, is_anonymous)
    - user_object: Patient model if authenticated, None if anonymous
    - user_id: Either user.id or anon_id
    - is_anonymous: True if using anonymous session
    """
    # If no token provided, use anonymous session
    if not token:
        from app.api.anon_session import get_or_create_anon_id
        anon_id = get_or_create_anon_id(request, response)
        set_log_user(anon_id)
        return (None, anon_id, True)
    
    try:
        # Try authenticated user first
        user = await get_current_user(token, db)
        set_log_user(user.id)
        return (user, user.id, False)
    except ReauthRequiredError:
        # Expired or superseded tokens must force re-auth, never an anonymous
        # session: the anonymous fallback would silently answer with an empty
        # dataset under someone else's (nonexistent) identity.
        raise
    except HTTPException as e:
        if e.status_code == status.HTTP_401_UNAUTHORIZED:
            # No valid token (missing/invalid), use anonymous session
            from app.api.anon_session import get_or_create_anon_id
            anon_id = get_or_create_anon_id(request, response)
            return (None, anon_id, True)
        raise


async def get_current_user_or_anon_strict(
    request: Request,
    response: Response,
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> tuple[Optional[models.Patient], str, bool]:
    """Like ``get_current_user_or_anon``, but a token that IS present and
    fails to validate (bad signature, unknown user, expired) is a hard 401
    instead of silently degrading to an anonymous session.

    Used by the import-job / notification endpoints: an auth race there must
    never answer with ANOTHER principal's (usually empty) list as a 200 — the
    frontend caches it and the real data only appears on the next poll tick.
    A fully ABSENT token still resolves to the anonymous session, so the
    anonymous flow (bell + tracker for anon's ≤5-doc imports) is unchanged."""
    if not token:
        from app.api.anon_session import get_or_create_anon_id
        anon_id = get_or_create_anon_id(request, response)
        set_log_user(anon_id)
        return (None, anon_id, True)
    # No 401 catch: invalid, expired or superseded tokens raise straight
    # through get_current_user (both markers are 401 HTTPExceptions).
    user = await get_current_user(token, db)
    return (user, user.id, False)


class UserCreateWithMigration(BaseModel):
    email: EmailStr
    password: str
    name: str
    dob: str = ""
    gender: str = ""
    migrate_data: bool = False


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(
    request: Request,
    response: Response,
    user_data: UserCreateWithMigration,
    db: Session = Depends(get_db)
):
    """Register a new user, optionally copying anonymous data."""
    _validate_password_length(user_data.password)

    # Normalized on the way in: one mailbox is one account, whatever casing
    # the client sent (EmailStr only lowercases the domain).
    email = normalize_email(user_data.email)

    # Check if email already exists
    if get_user_by_email(db, email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.email_already_registered"),
        )
    
    # Check for anonymous session (signature-verified; a forged or legacy
    # unsigned cookie must never trigger a migration of someone else's data).
    from app.api.anon_session import verify_anon_cookie
    anon_id = verify_anon_cookie(request.cookies.get(ANONYMOUS_COOKIE_NAME))
    
    # Honor the user's explicit choice (frontend always sends the flag;
    # checkbox defaults to checked, so an unchecked box means decline).
    should_migrate = user_data.migrate_data

    # Create the account and copy anonymous data in ONE transaction: if the
    # migration fails, the account creation is rolled back too, instead of
    # leaving a half-registered account behind (a retry would then hit the
    # email/PK constraints with an unhandled IntegrityError).
    try:
        user = create_user(
            db,
            email,
            user_data.password,
            user_data.name,
            user_data.dob,
            user_data.gender,
            commit=False,
        )
        if should_migrate and anon_id:
            copy_anonymous_data(db, anon_id, user.id, commit=False)
            # Note: We DON'T delete the anonymous data or usage limits
            # User can still access it if they log out
        db.commit()
    except IntegrityError:
        # TOCTOU on the email uniqueness check (concurrent registration):
        # the INSERT fails at commit/flush time — surface it as a 409.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=i18n.tr("auth.email_already_registered"),
        ) from None
    
    return UserResponse(
        id=user.id,
        email=user.email,
        name=user.name,
        dob=user.dob or "",
        gender=user.gender or "",
        external_id=user.external_id,
    )


@router.post("/login", response_model=TokenResponse)
def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    """Login with email and password.

    Failed attempts are throttled per-email and per-IP (ISSUES.md #51) —
    brute-forcing is no longer unthrottled while forgot-password already
    carries per-email/per-IP windows."""
    client_ip = request.client.host if request.client else "unknown"
    email_key = f"login:email:{form_data.username.lower()}"
    ip_key = f"login:ip:{client_ip}"
    if (
        _throttled(email_key, _LOGIN_FAIL_EMAIL_LIMIT, _LOGIN_FAIL_WINDOW, record=False)
        or _throttled(ip_key, _LOGIN_FAIL_IP_LIMIT, _LOGIN_FAIL_WINDOW, record=False)
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=i18n.tr("auth.too_many_login_attempts"),
        )
    _prune_throttle_keys()

    user = authenticate_user(db, form_data.username, form_data.password)
    if not user:
        _record_throttle(email_key)
        _record_throttle(ip_key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=i18n.tr("auth.incorrect_email_or_password"),
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Carries the account's token_version, so a later password reset / email
    # change can retire this token (see get_current_user).
    access_token = issue_access_token(user)
    return TokenResponse(access_token=access_token, token_type="bearer")


@router.get("/me", response_model=UserResponse)
def read_users_me(current_user: models.Patient = Depends(get_current_user)):
    """Get current authenticated user."""
    return UserResponse(
        id=current_user.id,
        email=current_user.email,
        name=current_user.name,
        dob=current_user.dob or "",
        gender=current_user.gender or "",
        external_id=current_user.external_id,
    )


class AnonIdResponse(BaseModel):
    anon_id: str


class EmailDeliveryStatus(BaseModel):
    enabled: bool


@router.get("/email-delivery", response_model=EmailDeliveryStatus)
def read_email_delivery_status():
    """Whether this instance can send email at all (password reset, email change).

    Public and account-independent on purpose: it leaks nothing about any user
    (it is an instance capability, not a per-address answer), and it is what
    lets the reset / email-change screens say "this instance cannot email you"
    instead of promising an inbox that will stay empty. Without SMTP the
    backend still answers 200 to keep the reset endpoint unenumerable, so this
    status is the only honest signal available to the person clicking.
    """
    return EmailDeliveryStatus(enabled=email_delivery_enabled())


@router.get("/anon-id", response_model=AnonIdResponse)
def read_anon_id(
    request: Request,
    response: Response,
):
    """Return the current anonymous session id (creating one if needed)."""
    from app.api.anon_session import get_or_create_anon_id
    return AnonIdResponse(anon_id=get_or_create_anon_id(request, response))


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    current_user: models.Patient = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Set a new password after verifying the current one (registered only).

    Anonymous principals fail `get_current_user` with 401 (not authenticated),
    mirroring /api/auth/me. The session version is bumped, so every token
    issued before this change — including the one that made this request — is
    rejected from now on and the user signs in again with the new password.
    """
    _validate_password_length(body.new_password)
    if not verify_password(body.current_password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.incorrect_password"),
        )
    current_user.hashed_password = get_password_hash(body.new_password)
    bump_token_version(current_user)
    db.commit()
    return {"message": i18n.tr("auth.message_password_changed")}


@router.delete("/account")
async def delete_account(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_data: tuple[Optional[models.Patient], str, bool] = Depends(get_current_user_or_anon),
):
    """Permanently delete the caller's data — the whole account for a
    registered principal, the anonymous session's data otherwise.

    Cascade order mirrors `DELETE /api/entry`: entries first (the ORM
    `all, delete-orphan` cascade removes readings, visit_data, instrumental_data
    and attachment rows), then on-disk files are unlinked only when no other
    Attachment row still references them (the anon→user migration duplicates
    rows across principals), then the caller's local definitions, reset
    tokens, usage-limit row and — for registered — the Patient row.
    """
    user, user_id, is_anonymous = user_data

    entries = (
        db.query(models.MedicalEntry)
        .filter(models.MedicalEntry.patient_id == user_id)
        .all()
    )
    # Snapshot file paths BEFORE the cascade deletes the attachment rows.
    attachment_paths = [
        a.file_path
        for e in entries
        for a in e.attachments
        if a.file_path
    ]

    for entry in entries:
        db.delete(entry)
    db.flush()  # surface cascades + let the unlink guard see remaining rows

    freed_bytes = unlink_unreferenced_files(db, attachment_paths)

    # Readings are gone with the entries, so the caller's local definitions
    # are now reading-free and safe to remove.
    db.query(models.BiomarkerDefinition).filter(
        models.BiomarkerDefinition.user_id == user_id,
        models.BiomarkerDefinition.scope == "local",
    ).delete(synchronize_session=False)
    for token_model in (models.PasswordResetToken, models.EmailChangeToken):
        db.query(token_model).filter(
            token_model.patient_id == user_id,
        ).delete(synchronize_session=False)
    db.query(models.UsageLimit).filter(
        models.UsageLimit.user_id == user_id,
    ).delete(synchronize_session=False)

    if user is not None:
        db.delete(user)
    db.commit()

    if is_anonymous:
        # A fresh session on the next visit: the old anon id no longer
        # resolves to anything.
        response.delete_cookie(ANONYMOUS_COOKIE_NAME)

    return {
        "message": i18n.tr("auth.message_account_deleted"),
        "deleted_entries": len(entries),
        "freed_bytes": freed_bytes,
    }


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


class ChangeEmailRequest(BaseModel):
    current_password: str
    new_email: EmailStr


class ConfirmEmailChangeRequest(BaseModel):
    token: str


RESET_TOKEN_TTL_MINUTES = 30
# Email changes are confirmed by a link sent to the NEW address; the pending
# window is short because nothing is at stake yet if it lapses.
EMAIL_CHANGE_TOKEN_TTL_MINUTES = 30

# In-memory rate limiting (no infra): per-key sliding windows keep the auth
# endpoints from being abused. The forgot-password endpoint throttles every
# request per-email and per-IP; login throttles FAILED attempts only so
# legitimate users sharing an IP are never locked out (ISSUES.md #51).
_throttle_windows: dict[str, deque] = defaultdict(deque)
_THROTTLE_MAX_KEYS = 10_000
# Login runs in Starlette's threadpool, so concurrent requests mutate this
# map from different threads; every access goes under the lock.
_throttle_lock = threading.Lock()


def _throttled(key: str, limit: int, window: timedelta, record: bool = True) -> bool:
    """Return True if `key` has reached `limit` entries in the window.

    Records the current attempt unless ``record=False`` — failed-attempt
    throttles check first and append only via :func:`_record_throttle` when
    the attempt actually fails."""
    now = datetime.now(timezone.utc)
    with _throttle_lock:
        q = _throttle_windows[key]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            return True
        if record:
            q.append(now)
        return False


def _record_throttle(key: str) -> None:
    with _throttle_lock:
        _throttle_windows[key].append(datetime.now(timezone.utc))


def _prune_throttle_keys() -> None:
    """Bound the in-memory throttle map.

    Every window is at most ``_RESET_WINDOW`` long, so a key whose entries are
    all older than that can never affect a decision again — drop it (this is
    what bounds one-shot keys, e.g. distinct failed-login emails, which are
    never queried a second time). A burst of distinct keys can still exceed
    the cap within the window, so evict the least-recently-active windows down
    to the cap; memory stays bounded by construction."""
    now = datetime.now(timezone.utc)
    with _throttle_lock:
        for key, q in list(_throttle_windows.items()):
            while q and now - q[0] > _RESET_WINDOW:
                q.popleft()
            if not q:
                del _throttle_windows[key]
        over = len(_throttle_windows) - _THROTTLE_MAX_KEYS
        if over <= 0:
            return
        evicted = 0
        for key, _ in sorted(
            _throttle_windows.items(), key=lambda kv: kv[1][-1]
        )[:over]:
            del _throttle_windows[key]
            evicted += 1
    logger.warning(
        "Throttle map exceeded %d keys — evicted %d least-recently-active windows",
        _THROTTLE_MAX_KEYS, evicted,
    )


_RESET_EMAIL_LIMIT = 5
_RESET_IP_LIMIT = 20
_RESET_WINDOW = timedelta(hours=1)

# Email-change requests are authenticated (one key per account, no IP key:
# a shared NAT must not lock a household out of its own account).
_EMAIL_CHANGE_LIMIT = 5
_EMAIL_CHANGE_WINDOW = timedelta(hours=1)

_LOGIN_FAIL_EMAIL_LIMIT = 10
_LOGIN_FAIL_IP_LIMIT = 30
_LOGIN_FAIL_WINDOW = timedelta(minutes=15)


def _hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _purge_stale_tokens(db: Session) -> None:
    """Opportunistic cleanup of expired or already-used auth tokens."""
    for model in (models.PasswordResetToken, models.EmailChangeToken):
        db.query(model).filter(
            (model.expires_at < datetime.now(timezone.utc))
            | (model.used_at.isnot(None))
        ).delete(synchronize_session=False)


@router.post("/forgot-password")
async def forgot_password(
    request: Request,
    body: ForgotPasswordRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Send a password-reset link if the email is registered.

    Always returns the same response so the endpoint can't be used to probe
    which emails have accounts — including in its timing: delivery is queued
    as a background task, so a registered address never pays the SMTP
    round-trip inside the response.
    """
    client_ip = request.client.host if request.client else "unknown"
    email_key = body.email.lower()
    if (
        _throttled(f"reset:email:{email_key}", _RESET_EMAIL_LIMIT, _RESET_WINDOW)
        or _throttled(f"reset:ip:{client_ip}", _RESET_IP_LIMIT, _RESET_WINDOW)
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=i18n.tr("auth.too_many_reset_requests"),
        )
    _prune_throttle_keys()

    _purge_stale_tokens(db)

    user = get_user_by_email(db, body.email)
    if user:
        token = secrets.token_urlsafe(32)
        db.add(models.PasswordResetToken(
            id=secrets.token_urlsafe(16),
            patient_id=user.id,
            token_hash=_hash_reset_token(token),
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=RESET_TOKEN_TTL_MINUTES),
        ))
    # Commit even when the email is unknown: the opportunistic purge above
    # must persist for unknown emails too (get_db only closes the session,
    # which would otherwise roll the DELETE back).
    db.commit()

    if user:
        reset_url = f"{FRONTEND_URL}/reset-password?token={token}"
        # Never leak delivery failures to the client: the response stays
        # uniform (no user enumeration) and the user can simply re-request.
        # `deliver` logs failures; the response is already written by then.
        background_tasks.add_task(deliver, "password reset", send_reset_email, body.email, reset_url)

    return {"message": i18n.tr("auth.message_reset_sent")}


@router.post("/reset-password")
async def reset_password(body: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Set a new password using a one-time reset token."""
    _validate_password_length(body.new_password)

    token = db.query(models.PasswordResetToken).filter(
        models.PasswordResetToken.token_hash == _hash_reset_token(body.token)
    ).first()
    if not token or token.used_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.invalid_reset_token"),
        )
    if token.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.invalid_reset_token"),
        )

    user = db.query(models.Patient).filter(models.Patient.id == token.patient_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.invalid_reset_token"),
        )

    # Single-use claim: the conditional UPDATE only matches a still-unused
    # token, so a concurrent second request with the same token loses the
    # race (rowcount 0) and can never overwrite the password again. Claim
    # before touching the hash so a later failure rolls both back together.
    claimed = db.execute(
        update(models.PasswordResetToken)
        .where(
            models.PasswordResetToken.id == token.id,
            models.PasswordResetToken.used_at.is_(None),
        )
        .values(used_at=datetime.now(timezone.utc))
    )
    if claimed.rowcount != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.invalid_reset_token"),
        )

    user.hashed_password = get_password_hash(body.new_password)
    # Retire every session issued before the reset: this is the remedy the
    # email-change notice tells the previous owner to use, so it must
    # actually evict an attacker who already holds a token.
    bump_token_version(user)
    db.commit()

    return {"message": i18n.tr("auth.message_password_updated")}


@router.post("/change-email")
async def change_email(
    body: ChangeEmailRequest,
    background_tasks: BackgroundTasks,
    current_user: models.Patient = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Start an email change (registered only): re-verify the password, then
    email a confirmation link to the NEW address.

    Double opt-in by construction — ``patients.email`` is not touched here, so
    a typo cannot lock the owner out; the switch happens only when the link is
    opened (`POST /confirm-email-change`). Verify-then-switch also means the
    new address is proven reachable before it becomes the login identity.

    An address already owned by another account is NOT reported as a 409: that
    answer would be an enumeration oracle (any signed-in user with their
    password could probe whether an arbitrary address has an account), which
    is exactly what forgot-password was built to avoid. The caller gets the
    same "confirmation link sent" response either way; the squatted address
    instead receives a notice that someone tried to use it.
    """
    new_email = normalize_email(body.new_email)
    if new_email == normalize_email(current_user.email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.email_unchanged"),
        )
    if _throttled(
        f"emailchange:user:{current_user.id}",
        _EMAIL_CHANGE_LIMIT,
        _EMAIL_CHANGE_WINDOW,
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=i18n.tr("auth.too_many_email_change_requests"),
        )
    _prune_throttle_keys()

    if not verify_password(body.current_password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.incorrect_password"),
        )

    existing = get_user_by_email(db, new_email)
    if existing is not None and existing.id != current_user.id:
        # Anti-enumeration: never reveal that the address is taken. Warn its
        # owner (they may be about to be impersonated) and answer the caller
        # exactly as for a free address — same body, same timing (the send is
        # a BackgroundTasks step). No token row: confirming one could only
        # ever conflict.
        background_tasks.add_task(
            deliver,
            "email change squatted notice",
            send_email_change_squatted_notice,
            new_email,
        )
        return {"message": i18n.tr("auth.message_email_change_sent", email=new_email)}

    _purge_stale_tokens(db)
    token = secrets.token_urlsafe(32)
    db.add(models.EmailChangeToken(
        id=secrets.token_urlsafe(16),
        patient_id=current_user.id,
        new_email=new_email,
        token_hash=_hash_reset_token(token),
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=EMAIL_CHANGE_TOKEN_TTL_MINUTES),
    ))
    db.commit()

    confirm_url = f"{FRONTEND_URL}/confirm-email-change?token={token}"
    background_tasks.add_task(
        deliver, "email change confirmation", send_email_change_email, new_email, confirm_url
    )
    return {"message": i18n.tr("auth.message_email_change_sent", email=new_email)}


@router.post("/confirm-email-change")
async def confirm_email_change(
    body: ConfirmEmailChangeRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Consume an email-change token: switch the account's address and warn the
    previous one.

    The token is the proof of control over the new address, so this endpoint is
    public (like reset-password) — it works even when the user is signed out.
    """
    token = db.query(models.EmailChangeToken).filter(
        models.EmailChangeToken.token_hash == _hash_reset_token(body.token)
    ).first()
    if not token or token.used_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.invalid_email_change_token"),
        )
    if token.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.invalid_email_change_token"),
        )

    user = db.query(models.Patient).filter(models.Patient.id == token.patient_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.invalid_email_change_token"),
        )

    # The address may have been claimed by another account between request and
    # confirmation; the unique index below is the real guard, this is the
    # friendly error.
    new_email = normalize_email(token.new_email)
    existing = get_user_by_email(db, new_email)
    if existing is not None and existing.id != user.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=i18n.tr("auth.email_already_registered"),
        )

    old_email = user.email
    # Single-use claim (same CAS pattern as reset-password): a concurrent
    # replay loses the race and can never switch the address twice.
    claimed = db.execute(
        update(models.EmailChangeToken)
        .where(
            models.EmailChangeToken.id == token.id,
            models.EmailChangeToken.used_at.is_(None),
        )
        .values(used_at=datetime.now(timezone.utc))
    )
    if claimed.rowcount != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=i18n.tr("auth.invalid_email_change_token"),
        )

    user.email = new_email
    # The login identity changed: retire every session issued under the old
    # address (the previous owner's copy included). The notice below points the
    # old address at /forgot-password, which now works as advertised.
    bump_token_version(user)
    try:
        db.commit()
    except IntegrityError:
        # Concurrent registration of the same address: the unique index wins.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=i18n.tr("auth.email_already_registered"),
        ) from None

    background_tasks.add_task(
        deliver,
        "email change notice",
        send_email_change_notice,
        old_email,
        new_email,
        f"{FRONTEND_URL}/forgot-password",
    )
    return {"message": i18n.tr("auth.message_email_changed", email=new_email)}
