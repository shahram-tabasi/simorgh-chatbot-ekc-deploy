"""
Authentication Models (Pydantic)

Data validation and serialization models for the authentication system.
"""

from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, EmailStr, Field, validator
import re
from uuid import UUID


# =============================================================================
# Password Validation Constants
# =============================================================================
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128


def validate_password_strength(password: str) -> str:
    """Validate password meets security requirements."""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at most {MAX_PASSWORD_LENGTH} characters")
    if not re.search(r'[A-Z]', password):
        raise ValueError("Password must contain at least one uppercase letter")
    if not re.search(r'[a-z]', password):
        raise ValueError("Password must contain at least one lowercase letter")
    if not re.search(r'\d', password):
        raise ValueError("Password must contain at least one digit")
    if not re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
        raise ValueError("Password must contain at least one special character")
    return password


# =============================================================================
# Request Models
# =============================================================================

class UserRegisterRequest(BaseModel):
    """Request model for user registration."""
    email: EmailStr
    password: str = Field(..., min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)
    first_name: Optional[str] = Field(None, max_length=100)
    last_name: Optional[str] = Field(None, max_length=100)

    @validator('password')
    def validate_password(cls, v):
        return validate_password_strength(v)

    @validator('email')
    def normalize_email(cls, v):
        return v.lower().strip()


class UserLoginRequest(BaseModel):
    """Request model for user login."""
    email: EmailStr
    password: str


class PasswordResetRequest(BaseModel):
    """Request model for initiating password reset."""
    email: EmailStr


class PasswordResetConfirm(BaseModel):
    """Request model for confirming password reset."""
    token: str
    new_password: str = Field(..., min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)

    @validator('new_password')
    def validate_password(cls, v):
        return validate_password_strength(v)


class PasswordChangeRequest(BaseModel):
    """Request model for changing password (when logged in)."""
    current_password: str
    new_password: str = Field(..., min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)

    @validator('new_password')
    def validate_password(cls, v):
        return validate_password_strength(v)


class EmailVerificationRequest(BaseModel):
    """Request model for email verification."""
    token: str


class ResendVerificationRequest(BaseModel):
    """Request model for resending verification email."""
    email: EmailStr


class RefreshTokenRequest(BaseModel):
    """Request model for refreshing access token."""
    refresh_token: str


class GoogleOAuthRequest(BaseModel):
    """Request model for Google OAuth callback."""
    code: str
    redirect_uri: Optional[str] = None


class UpdateProfileRequest(BaseModel):
    """Request model for updating user profile."""
    first_name: Optional[str] = Field(None, max_length=100)
    last_name: Optional[str] = Field(None, max_length=100)
    display_name: Optional[str] = Field(None, max_length=200)
    avatar_url: Optional[str] = None


class UpdatePreferencesRequest(BaseModel):
    """Request model for updating user preferences."""
    theme: Optional[str] = Field(None, pattern='^(light|dark|system)$')
    language: Optional[str] = Field(None, max_length=10)
    ai_mode: Optional[str] = Field(None, pattern='^(online|local|auto)$')
    notifications_enabled: Optional[bool] = None


# =============================================================================
# Response Models
# =============================================================================

class UserResponse(BaseModel):
    """Response model for user data."""
    id: UUID
    email: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    email_verified: bool = False
    is_active: bool = True
    created_at: datetime
    last_login_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class AuthTokenResponse(BaseModel):
    """Response model for authentication tokens."""
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int  # seconds
    user: UserResponse


class LoginResponse(BaseModel):
    """Response model for login (backward compatible)."""
    access_token: str
    refresh_token: Optional[str] = None
    token_type: str = "bearer"
    user: UserResponse


class MessageResponse(BaseModel):
    """Generic message response."""
    message: str
    success: bool = True


class EmailVerificationResponse(BaseModel):
    """Response for email verification."""
    message: str
    email_verified: bool
    user: Optional[UserResponse] = None


class PasswordResetResponse(BaseModel):
    """Response for password reset."""
    message: str
    success: bool


class OAuthProviderResponse(BaseModel):
    """Response model for OAuth provider data."""
    provider: str
    provider_email: Optional[str] = None
    connected_at: datetime


class UserWithOAuthResponse(UserResponse):
    """Extended user response with OAuth connections."""
    oauth_providers: List[OAuthProviderResponse] = []


class SessionResponse(BaseModel):
    """Response model for user session."""
    id: UUID
    device_info: Optional[dict] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    last_activity_at: datetime
    created_at: datetime


class UserPreferencesResponse(BaseModel):
    """Response model for user preferences."""
    theme: str = "light"
    language: str = "en"
    ai_mode: str = "online"
    notifications_enabled: bool = True
    preferences_data: dict = {}


# =============================================================================
# Internal Models
# =============================================================================

class TokenPayload(BaseModel):
    """JWT token payload structure."""
    sub: str  # user_id
    email: str
    type: str = "access"  # "access" or "refresh"
    exp: int  # expiration timestamp
    iat: int  # issued at timestamp
    jti: Optional[str] = None  # JWT ID for refresh tokens


class UserInDB(BaseModel):
    """Internal model for user with password hash."""
    id: UUID
    email: str
    password_hash: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    email_verified: bool = False
    is_active: bool = True
    is_superuser: bool = False
    failed_login_attempts: int = 0
    locked_until: Optional[datetime] = None
    last_login_at: Optional[datetime] = None
    last_login_ip: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class OAuthAccountInDB(BaseModel):
    """Internal model for OAuth account."""
    id: UUID
    user_id: UUID
    provider: str
    provider_user_id: str
    provider_email: Optional[str] = None
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    token_expires_at: Optional[datetime] = None
    raw_user_data: Optional[dict] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# =============================================================================
# Error Models
# =============================================================================

class AuthError(BaseModel):
    """Authentication error response."""
    error: str
    error_description: str
    status_code: int = 401


class ValidationError(BaseModel):
    """Validation error response."""
    error: str = "validation_error"
    details: List[dict]
    status_code: int = 422
