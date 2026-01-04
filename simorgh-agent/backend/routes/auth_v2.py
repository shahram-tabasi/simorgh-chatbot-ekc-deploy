"""
Modern Authentication Routes (v2)
=================================

Modern authentication system with:
- Email/password registration and login
- Email verification
- Google OAuth 2.0
- Password reset
- JWT with refresh tokens
- Rate limiting

Author: Simorgh Industrial Assistant
"""

import os
import logging
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Depends, Header, Request, Response, Cookie
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from models.auth_models import (
    UserRegisterRequest,
    UserLoginRequest,
    PasswordResetRequest,
    PasswordResetConfirm,
    PasswordChangeRequest,
    EmailVerificationRequest,
    ResendVerificationRequest,
    RefreshTokenRequest,
    GoogleOAuthRequest,
    UpdateProfileRequest,
    UpdatePreferencesRequest,
    UserResponse,
    AuthTokenResponse,
    LoginResponse,
    MessageResponse,
    EmailVerificationResponse,
    PasswordResetResponse,
    UserPreferencesResponse,
    SessionResponse,
)
from services.postgres_auth_service import get_postgres_auth_service, PostgresAuthService
from services.oauth_service import get_oauth_service, OAuthService
from services.email_service import get_email_service, EmailService
from services.tpms_auth_service import get_tpms_auth_service, TPMSAuthService
from services.auth_utils import create_access_token, get_current_username_from_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/v2", tags=["Authentication v2"])

# Configuration
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
SECURE_COOKIES = os.getenv("SECURE_COOKIES", "false").lower() == "true"
COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN", None)

# Rate limiting settings
RATE_LIMIT_WINDOW = 15  # minutes
RATE_LIMIT_MAX_ATTEMPTS = 5


# =============================================================================
# Helper Functions
# =============================================================================

def get_client_ip(request: Request) -> str:
    """Extract client IP from request."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


def set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    """Set authentication cookies."""
    response.set_cookie(
        key="access_token",
        value=access_token,
        httponly=True,
        secure=SECURE_COOKIES,
        samesite="lax",
        max_age=3600,  # 1 hour
        domain=COOKIE_DOMAIN,
    )
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=SECURE_COOKIES,
        samesite="lax",
        max_age=30 * 24 * 3600,  # 30 days
        domain=COOKIE_DOMAIN,
    )


def clear_auth_cookies(response: Response) -> None:
    """Clear authentication cookies."""
    response.delete_cookie(key="access_token", domain=COOKIE_DOMAIN)
    response.delete_cookie(key="refresh_token", domain=COOKIE_DOMAIN)


async def get_current_user(
    request: Request,
    authorization: str = Header(None),
    access_token: str = Cookie(None),
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service)
) -> dict:
    """Get current authenticated user from token."""
    # Try Authorization header first, then cookie
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.replace("Bearer ", "")
    elif access_token:
        token = access_token

    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = auth_service.decode_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    user = await auth_service.get_user_by_id(UUID(user_id))
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    if not user.get("is_active", True):
        raise HTTPException(status_code=401, detail="Account is not active")

    return user


# =============================================================================
# REGISTRATION ENDPOINTS
# =============================================================================

@router.post("/register", response_model=MessageResponse)
async def register(
    request: Request,
    data: UserRegisterRequest,
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service),
    email_service: EmailService = Depends(get_email_service)
):
    """
    Register a new user account.

    **Process:**
    1. Validate email and password
    2. Create user account with hashed password
    3. Send verification email
    4. Return success message

    **Password Requirements:**
    - Minimum 8 characters
    - At least one uppercase letter
    - At least one lowercase letter
    - At least one digit
    - At least one special character
    """
    ip_address = get_client_ip(request)

    # Check rate limit
    is_allowed, remaining = await auth_service.check_rate_limit(
        data.email, ip_address, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_ATTEMPTS
    )
    if not is_allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Please try again later."
        )

    # Register user
    user, error = await auth_service.register_user(
        email=data.email,
        password=data.password,
        first_name=data.first_name,
        last_name=data.last_name
    )

    if error:
        raise HTTPException(status_code=400, detail=error)

    # Create verification token and send email
    verification_token = await auth_service.create_email_verification_token(user['id'])
    if verification_token:
        user_name = data.first_name or data.email.split('@')[0]
        await email_service.send_verification_email(
            data.email,
            verification_token,
            user_name
        )

    logger.info(f"User registered: {data.email}")

    return MessageResponse(
        message="Registration successful! Please check your email to verify your account.",
        success=True
    )


@router.post("/verify-email", response_model=EmailVerificationResponse)
async def verify_email(
    data: EmailVerificationRequest,
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service),
    email_service: EmailService = Depends(get_email_service)
):
    """
    Verify email address using verification token.
    """
    user, error = await auth_service.verify_email_token(data.token)

    if error:
        raise HTTPException(status_code=400, detail=error)

    # Send welcome email
    if user:
        user_name = user.get('first_name') or user['email'].split('@')[0]
        await email_service.send_welcome_email(user['email'], user_name)

    logger.info(f"Email verified: {user['email']}")

    return EmailVerificationResponse(
        message="Email verified successfully!",
        email_verified=True,
        user=UserResponse(**user) if user else None
    )


@router.post("/resend-verification", response_model=MessageResponse)
async def resend_verification(
    request: Request,
    data: ResendVerificationRequest,
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service),
    email_service: EmailService = Depends(get_email_service)
):
    """
    Resend email verification link.
    """
    ip_address = get_client_ip(request)

    # Rate limit check
    is_allowed, _ = await auth_service.check_rate_limit(
        data.email, ip_address, RATE_LIMIT_WINDOW, 3
    )
    if not is_allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please try again later."
        )

    user = await auth_service.get_user_by_email(data.email)

    if user and not user.get('email_verified'):
        verification_token = await auth_service.create_email_verification_token(user['id'])
        if verification_token:
            user_name = user.get('first_name') or data.email.split('@')[0]
            await email_service.send_verification_email(
                data.email,
                verification_token,
                user_name
            )

    # Always return success to prevent email enumeration
    return MessageResponse(
        message="If an account exists with this email, a verification link has been sent.",
        success=True
    )


# =============================================================================
# LOGIN ENDPOINTS
# =============================================================================

@router.post("/login", response_model=LoginResponse)
async def login(
    request: Request,
    response: Response,
    data: UserLoginRequest,
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service)
):
    """
    Login with email and password.

    **Returns:**
    - access_token: JWT token for API authentication
    - refresh_token: Token for obtaining new access tokens
    - user: User profile information
    """
    ip_address = get_client_ip(request)
    user_agent = request.headers.get("User-Agent")

    # Rate limit check
    is_allowed, remaining = await auth_service.check_rate_limit(
        data.email, ip_address, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_ATTEMPTS
    )
    if not is_allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts. Please try again later.",
            headers={"Retry-After": str(RATE_LIMIT_WINDOW * 60)}
        )

    # Authenticate
    user, error = await auth_service.authenticate_user(
        email=data.email,
        password=data.password,
        ip_address=ip_address,
        user_agent=user_agent
    )

    if error:
        raise HTTPException(status_code=401, detail=error)

    # Generate tokens
    access_token = auth_service.create_access_token(str(user['id']), user['email'])
    refresh_token, refresh_hash = auth_service.create_refresh_token(str(user['id']), user['email'])

    # Store refresh token
    await auth_service.store_refresh_token(
        user['id'],
        refresh_hash,
        device_info={"user_agent": user_agent},
        ip_address=ip_address
    )

    # Set cookies
    set_auth_cookies(response, access_token, refresh_token)

    logger.info(f"User logged in: {user['email']}")

    return LoginResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        user=UserResponse(**user)
    )


@router.post("/refresh", response_model=LoginResponse)
async def refresh_token(
    request: Request,
    response: Response,
    data: RefreshTokenRequest = None,
    refresh_token_cookie: str = Cookie(None, alias="refresh_token"),
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service)
):
    """
    Refresh access token using refresh token.
    """
    # Get refresh token from body or cookie
    refresh_token = data.refresh_token if data else refresh_token_cookie

    if not refresh_token:
        raise HTTPException(status_code=401, detail="Refresh token required")

    # Decode and validate refresh token
    payload = auth_service.decode_token(refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    user_id = payload.get("sub")
    jti = payload.get("jti")

    if not user_id or not jti:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    # Verify refresh token is not revoked
    token_data = await auth_service.validate_refresh_token(jti)
    if not token_data:
        raise HTTPException(status_code=401, detail="Refresh token is invalid or revoked")

    # Get user
    user = await auth_service.get_user_by_id(UUID(user_id))
    if not user or not user.get("is_active"):
        raise HTTPException(status_code=401, detail="User not found or inactive")

    # Generate new tokens
    new_access_token = auth_service.create_access_token(str(user['id']), user['email'])
    new_refresh_token, new_refresh_hash = auth_service.create_refresh_token(str(user['id']), user['email'])

    # Revoke old refresh token and store new one
    await auth_service.revoke_refresh_token(jti)
    await auth_service.store_refresh_token(
        user['id'],
        new_refresh_hash,
        ip_address=get_client_ip(request)
    )

    # Set cookies
    set_auth_cookies(response, new_access_token, new_refresh_token)

    return LoginResponse(
        access_token=new_access_token,
        refresh_token=new_refresh_token,
        user=UserResponse(**user)
    )


@router.post("/logout", response_model=MessageResponse)
async def logout(
    request: Request,
    response: Response,
    authorization: str = Header(None),
    refresh_token_cookie: str = Cookie(None, alias="refresh_token"),
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service)
):
    """
    Logout and revoke refresh token.
    """
    refresh_token = refresh_token_cookie

    if refresh_token:
        payload = auth_service.decode_token(refresh_token)
        if payload and payload.get("jti"):
            await auth_service.revoke_refresh_token(payload.get("jti"))

    clear_auth_cookies(response)

    return MessageResponse(message="Logged out successfully", success=True)


@router.post("/logout-all", response_model=MessageResponse)
async def logout_all_devices(
    response: Response,
    current_user: dict = Depends(get_current_user),
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service)
):
    """
    Logout from all devices by revoking all refresh tokens.
    """
    await auth_service.revoke_all_user_tokens(current_user['id'])
    clear_auth_cookies(response)

    logger.info(f"User logged out from all devices: {current_user['email']}")

    return MessageResponse(message="Logged out from all devices", success=True)


# =============================================================================
# GOOGLE OAUTH ENDPOINTS
# =============================================================================

@router.get("/google")
async def google_auth_redirect(
    request: Request,
    redirect_uri: Optional[str] = None,
    oauth_service: OAuthService = Depends(get_oauth_service)
):
    """
    Initiate Google OAuth flow.
    Redirects to Google's authorization page.
    """
    try:
        auth_url = oauth_service.get_google_auth_url(redirect_uri)
        return RedirectResponse(url=auth_url)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/google/callback", response_model=LoginResponse)
async def google_auth_callback(
    request: Request,
    response: Response,
    data: GoogleOAuthRequest,
    oauth_service: OAuthService = Depends(get_oauth_service)
):
    """
    Handle Google OAuth callback.
    Exchange code for tokens and authenticate/register user.
    """
    ip_address = get_client_ip(request)

    result, error = await oauth_service.authenticate_with_google(
        code=data.code,
        redirect_uri=data.redirect_uri,
        ip_address=ip_address
    )

    if error:
        raise HTTPException(status_code=400, detail=error)

    # Set cookies
    set_auth_cookies(response, result['access_token'], result['refresh_token'])

    logger.info(f"User authenticated via Google: {result['user']['email']}")

    return LoginResponse(
        access_token=result['access_token'],
        refresh_token=result['refresh_token'],
        user=UserResponse(**result['user'])
    )


@router.get("/google/url")
async def get_google_auth_url(
    redirect_uri: Optional[str] = None,
    oauth_service: OAuthService = Depends(get_oauth_service)
):
    """
    Get Google OAuth authorization URL without redirect.
    Useful for SPAs that want to handle the redirect themselves.
    """
    try:
        auth_url = oauth_service.get_google_auth_url(redirect_uri)
        return {"auth_url": auth_url}
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# PASSWORD RESET ENDPOINTS
# =============================================================================

@router.post("/forgot-password", response_model=MessageResponse)
async def forgot_password(
    request: Request,
    data: PasswordResetRequest,
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service),
    email_service: EmailService = Depends(get_email_service)
):
    """
    Request password reset email.
    """
    ip_address = get_client_ip(request)

    # Rate limit
    is_allowed, _ = await auth_service.check_rate_limit(
        data.email, ip_address, RATE_LIMIT_WINDOW, 3
    )
    if not is_allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please try again later."
        )

    token, error = await auth_service.create_password_reset_token(data.email)

    if token:
        user = await auth_service.get_user_by_email(data.email)
        user_name = user.get('first_name') if user else None
        await email_service.send_password_reset_email(data.email, token, user_name)
        logger.info(f"Password reset requested for: {data.email}")

    # Always return success to prevent email enumeration
    return MessageResponse(
        message="If an account exists with this email, a password reset link has been sent.",
        success=True
    )


@router.post("/reset-password", response_model=PasswordResetResponse)
async def reset_password(
    data: PasswordResetConfirm,
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service),
    email_service: EmailService = Depends(get_email_service)
):
    """
    Reset password using reset token.
    """
    success, error = await auth_service.reset_password(data.token, data.new_password)

    if not success:
        raise HTTPException(status_code=400, detail=error)

    # Get user and send notification
    # Note: We can't easily get the user here since token is consumed
    # Consider adding this in a production system

    return PasswordResetResponse(
        message="Password has been reset successfully. You can now login with your new password.",
        success=True
    )


@router.post("/change-password", response_model=MessageResponse)
async def change_password(
    data: PasswordChangeRequest,
    current_user: dict = Depends(get_current_user),
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service),
    email_service: EmailService = Depends(get_email_service)
):
    """
    Change password for authenticated user.
    """
    success, error = await auth_service.change_password(
        current_user['id'],
        data.current_password,
        data.new_password
    )

    if not success:
        raise HTTPException(status_code=400, detail=error)

    # Send notification email
    user_name = current_user.get('first_name')
    await email_service.send_password_changed_email(current_user['email'], user_name)

    logger.info(f"Password changed for: {current_user['email']}")

    return MessageResponse(message="Password changed successfully", success=True)


# =============================================================================
# USER PROFILE ENDPOINTS
# =============================================================================

@router.get("/me", response_model=UserResponse)
async def get_me(current_user: dict = Depends(get_current_user)):
    """
    Get current user profile.
    """
    return UserResponse(**current_user)


@router.patch("/me", response_model=UserResponse)
async def update_profile(
    data: UpdateProfileRequest,
    current_user: dict = Depends(get_current_user),
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service)
):
    """
    Update current user profile.
    """
    updated_user = await auth_service.update_profile(
        current_user['id'],
        first_name=data.first_name,
        last_name=data.last_name,
        display_name=data.display_name,
        avatar_url=data.avatar_url
    )

    if not updated_user:
        raise HTTPException(status_code=500, detail="Failed to update profile")

    return UserResponse(**updated_user)


@router.get("/me/preferences", response_model=UserPreferencesResponse)
async def get_preferences(
    current_user: dict = Depends(get_current_user),
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service)
):
    """
    Get user preferences.
    """
    prefs = await auth_service.get_user_preferences(current_user['id'])

    if not prefs:
        return UserPreferencesResponse()

    return UserPreferencesResponse(**prefs)


@router.patch("/me/preferences", response_model=UserPreferencesResponse)
async def update_preferences(
    data: UpdatePreferencesRequest,
    current_user: dict = Depends(get_current_user),
    auth_service: PostgresAuthService = Depends(get_postgres_auth_service)
):
    """
    Update user preferences.
    """
    updated_prefs = await auth_service.update_user_preferences(
        current_user['id'],
        theme=data.theme,
        language=data.language,
        ai_mode=data.ai_mode,
        notifications_enabled=data.notifications_enabled
    )

    if not updated_prefs:
        raise HTTPException(status_code=500, detail="Failed to update preferences")

    return UserPreferencesResponse(**updated_prefs)


@router.get("/me/oauth-providers")
async def get_oauth_providers(
    current_user: dict = Depends(get_current_user),
    oauth_service: OAuthService = Depends(get_oauth_service)
):
    """
    Get connected OAuth providers.
    """
    providers = await oauth_service.get_user_oauth_providers(current_user['id'])
    return {"providers": providers}


@router.delete("/me/oauth-providers/{provider}", response_model=MessageResponse)
async def unlink_oauth_provider(
    provider: str,
    current_user: dict = Depends(get_current_user),
    oauth_service: OAuthService = Depends(get_oauth_service)
):
    """
    Unlink an OAuth provider from the account.
    """
    success, error = await oauth_service.unlink_oauth_provider(current_user['id'], provider)

    if not success:
        raise HTTPException(status_code=400, detail=error)

    return MessageResponse(message=f"{provider.title()} account unlinked", success=True)


# =============================================================================
# LEGACY COMPATIBILITY - Bridge to TPMS auth
# =============================================================================

class LegacyLoginRequest(BaseModel):
    """Legacy login request (username/password for TPMS)"""
    username: str
    password: str


@router.post("/legacy/login")
async def legacy_login(
    request: LegacyLoginRequest,
    tpms_auth: TPMSAuthService = Depends(get_tpms_auth_service)
):
    """
    Legacy login endpoint for TPMS username/password authentication.
    Use this for existing users who haven't migrated to the new system.
    """
    user = tpms_auth.authenticate_user(request.username, request.password)

    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    # Create JWT token using legacy format
    access_token = create_access_token(data={"sub": user["EMPUSERNAME"]})

    logger.info(f"Legacy login: {user['EMPUSERNAME']}")

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user,
        "auth_method": "legacy_tpms"
    }
