"""
Authentication API routes for HealthPassport.
Handles registration, login, and current user info.
"""

from datetime import timedelta
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, status, Request, Response
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    authenticate_user,
    create_access_token,
    create_user,
    decode_token,
    get_user_by_email,
)
from app.db.session import get_db
from app.db import models
from app.services.data_migration import has_anonymous_data, copy_anonymous_data
from config import ANONYMOUS_COOKIE_NAME

router = APIRouter(prefix="/api/auth", tags=["auth"])

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


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
    payload = decode_token(token)
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
) -> Tuple[Optional[models.Patient], str, bool]:
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
        if e.status_code == status.HTTP_401_UNAUTHORIZED:
            # No valid token, use anonymous session
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
    # Check if email already exists
    if get_user_by_email(db, user_data.email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )
    
    # Check for anonymous session
    anon_id = request.cookies.get(ANONYMOUS_COOKIE_NAME)
    
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
        external_id=current_user.external_id,
    )