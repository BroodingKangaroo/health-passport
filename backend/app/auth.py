"""
Authentication utilities: password hashing, JWT tokens, user management.
"""

import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from sqlalchemy.orm import Session

from app.db import models

# JWT settings
def _get_secret_key() -> str:
    """Resolve a stable JWT secret.

    Prefer an explicit env var, then the committed dev secret file, and only
    fall back to a random value as a last resort. Previously this read
    ``SECRET_KEY`` while ``.env`` defined ``JWT_SECRET_KEY``, so a fresh random
    secret was generated on every restart and all issued tokens became invalid.
    """
    env = os.environ.get("SECRET_KEY") or os.environ.get("JWT_SECRET_KEY")
    if env:
        return env
    jwt_secret_file = os.path.join(os.path.dirname(__file__), "..", ".jwt_secret")
    if os.path.exists(jwt_secret_file):
        with open(jwt_secret_file) as f:
            return f.read().strip()
    return secrets.token_urlsafe(32)


SECRET_KEY = _get_secret_key()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain password against a hash."""
    return bcrypt.checkpw(plain_password.encode(), hashed_password.encode())


def get_password_hash(password: str) -> str:
    """Hash a password using bcrypt."""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def decode_token(token: str) -> Optional[dict]:
    """Decode and validate a JWT token.

    Expired tokens raise ``jwt.ExpiredSignatureError`` so callers can force a
    re-auth instead of silently treating the user as anonymous. Any other
    validation error (bad signature, malformed) returns ``None``.
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise
    except jwt.PyJWTError:
        return None


def get_user_by_email(db: Session, email: str) -> Optional[models.Patient]:
    """Get a user by email."""
    return db.query(models.Patient).filter(models.Patient.email == email).first()


def authenticate_user(db: Session, email: str, password: str) -> Optional[models.Patient]:
    """Authenticate a user with email and password."""
    user = get_user_by_email(db, email)
    if not user:
        return None
    if not verify_password(password, user.hashed_password):
        return None
    return user


def create_user(db: Session, email: str, password: str, name: str, dob: str, gender: str) -> models.Patient:
    """Create a new user."""
    user_id = uuid.uuid4().hex
    hashed_password = get_password_hash(password)
    external_id = f"HP-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{secrets.randbelow(10000):04d}"
    
    user = models.Patient(
        id=user_id,
        email=email,
        hashed_password=hashed_password,
        name=name,
        dob=dob,
        gender=gender,
        external_id=external_id,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user