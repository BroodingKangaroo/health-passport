"""
Authentication utilities: password hashing, JWT tokens, user management.
"""

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from sqlalchemy.orm import Session

from app.db import models
from app.db.session import SessionLocal

# JWT settings
SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_urlsafe(32)
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
    """Decode and validate a JWT token."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except jwt.PyJWTError:
        return None


def get_user_by_email(db: Session, email: str) -> Optional[models.Patient]:
    """Get a user by email."""
    return db.query(models.Patient).filter(models.Patient.email == email).first()


def get_user_by_id(db: Session, user_id: str) -> Optional[models.Patient]:
    """Get a user by ID."""
    return db.query(models.Patient).filter(models.Patient.id == user_id).first()


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
    user_id = hashlib.md5(email.encode()).hexdigest()[:12]
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


def get_current_user(token: str) -> Optional[models.Patient]:
    """Get current user from token (for use in API dependencies)."""
    payload = decode_token(token)
    if not payload:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    db = SessionLocal()
    try:
        return get_user_by_id(db, user_id)
    finally:
        db.close()