"""
Authentication API routes for HealthPassport.
Handles registration, login, current user info, and password reset.
"""

import hashlib
import logging
import secrets
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jwt import ExpiredSignatureError
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    authenticate_user,
    create_access_token,
    create_user,
    decode_token,
    get_password_hash,
    get_user_by_email,
)
from app.db import models
from app.db.session import get_db
from app.services.data_migration import copy_anonymous_data
from app.services.mailer import send_reset_email
from config import ANONYMOUS_COOKIE_NAME, FRONTEND_URL

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

PASSWORD_MIN_LENGTH = 8


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
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = decode_token(token)
    except ExpiredSignatureError:
        # Surface expiry distinctly so the frontend can prompt a re-login
        # rather than silently falling back to an empty anonymous session.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = db.query(models.Patient).filter(models.Patient.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
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
        return (None, anon_id, True)
    
    try:
        # Try authenticated user first
        user = await get_current_user(token, db)
        return (user, user.id, False)
    except HTTPException as e:
        if e.status_code == status.HTTP_401_UNAUTHORIZED and e.detail != "Token expired":
            # No valid token (missing/invalid), use anonymous session
            from app.api.anon_session import get_or_create_anon_id
            anon_id = get_or_create_anon_id(request, response)
            return (None, anon_id, True)
        raise


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
    if len(user_data.password) < PASSWORD_MIN_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Password must be at least {PASSWORD_MIN_LENGTH} characters",
        )

    # Check if email already exists
    if get_user_by_email(db, user_data.email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )
    
    # Check for anonymous session (signature-verified; a forged or legacy
    # unsigned cookie must never trigger a migration of someone else's data).
    from app.api.anon_session import verify_anon_cookie
    anon_id = verify_anon_cookie(request.cookies.get(ANONYMOUS_COOKIE_NAME))
    
    # Honor the user's explicit choice (frontend always sends the flag;
    # checkbox defaults to checked, so an unchecked box means decline).
    should_migrate = user_data.migrate_data

    # Create new user
    user = create_user(db, user_data.email, user_data.password, user_data.name, user_data.dob, user_data.gender)
    
    # Copy anonymous data if applicable
    if should_migrate and anon_id:
        copy_anonymous_data(db, anon_id, user.id)
        # Note: We DON'T delete the anonymous data or usage limits
        # User can still access it if they log out
    
    return UserResponse(
        id=user.id,
        email=user.email,
        name=user.name,
        dob=user.dob or "",
        gender=user.gender or "",
        external_id=user.external_id,
    )


@router.post("/login", response_model=TokenResponse)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    """Login with email and password."""
    user = authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.id, "email": user.email},
        expires_delta=access_token_expires,
    )
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


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


RESET_TOKEN_TTL_MINUTES = 30

# In-memory rate limiting for the request endpoint (no infra): per-email and
# per-IP windows keep the endpoint from being abused to spam mailboxes.
_reset_attempts: dict[str, deque] = defaultdict(deque)
_RESET_EMAIL_LIMIT = 5
_RESET_IP_LIMIT = 20
_RESET_WINDOW = timedelta(hours=1)
_RESET_ATTEMPTS_MAX_KEYS = 10_000


def _reset_throttled(key: str, limit: int) -> bool:
    """Return True if `key` has exceeded `limit` requests in the window."""
    now = datetime.now(timezone.utc)
    q = _reset_attempts[key]
    while q and now - q[0] > _RESET_WINDOW:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(now)
    return False


def _prune_reset_attempts() -> None:
    """Bound the in-memory throttle: drop keys whose windows have emptied."""
    if len(_reset_attempts) < _RESET_ATTEMPTS_MAX_KEYS:
        return
    for key, q in list(_reset_attempts.items()):
        if not q:
            del _reset_attempts[key]


def _hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _purge_stale_tokens(db: Session) -> None:
    """Opportunistic cleanup of expired or already-used reset tokens."""
    db.query(models.PasswordResetToken).filter(
        (models.PasswordResetToken.expires_at < datetime.now(timezone.utc))
        | (models.PasswordResetToken.used_at.isnot(None))
    ).delete(synchronize_session=False)


@router.post("/forgot-password")
async def forgot_password(request: Request, body: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """Send a password-reset link if the email is registered.

    Always returns the same response so the endpoint can't be used to probe
    which emails have accounts.
    """
    client_ip = request.client.host if request.client else "unknown"
    email_key = body.email.lower()
    if (
        _reset_throttled(f"email:{email_key}", _RESET_EMAIL_LIMIT)
        or _reset_throttled(f"ip:{client_ip}", _RESET_IP_LIMIT)
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many reset requests. Try again later.",
        )
    _prune_reset_attempts()

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
        db.commit()
        reset_url = f"{FRONTEND_URL}/reset-password?token={token}"
        try:
            await run_in_threadpool(send_reset_email, body.email, reset_url)
        except Exception:
            # Never leak delivery failures to the client: the response stays
            # uniform (no user enumeration) and the user can simply re-request.
            logger.exception("Failed to send password reset email to %s", body.email)

    return {"message": "If an account exists for this email, a reset link has been sent."}


@router.post("/reset-password")
async def reset_password(body: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Set a new password using a one-time reset token."""
    if len(body.new_password) < PASSWORD_MIN_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Password must be at least {PASSWORD_MIN_LENGTH} characters",
        )

    token = db.query(models.PasswordResetToken).filter(
        models.PasswordResetToken.token_hash == _hash_reset_token(body.token)
    ).first()
    if not token or token.used_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token",
        )
    if token.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token",
        )

    user = db.query(models.Patient).filter(models.Patient.id == token.patient_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token",
        )

    user.hashed_password = get_password_hash(body.new_password)
    token.used_at = datetime.now(timezone.utc)
    db.commit()

    return {"message": "Password updated. You can now sign in with your new password."}