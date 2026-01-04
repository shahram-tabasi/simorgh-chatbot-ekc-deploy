"""
PostgreSQL Authentication Service

Handles all user authentication operations using the PostgreSQL database.
This service manages user registration, login, token management, and account operations.
"""

import os
import logging
import secrets
import hashlib
from datetime import datetime, timedelta
from typing import Optional, Tuple, List
from uuid import UUID
import bcrypt
from passlib.context import CryptContext
import jwt

from database.postgres_connection import get_db

logger = logging.getLogger(__name__)

# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# JWT Configuration
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "change-this-secret-key-in-production")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "30"))

# Rate limiting
MAX_LOGIN_ATTEMPTS = int(os.getenv("MAX_LOGIN_ATTEMPTS", "5"))
LOCKOUT_DURATION_MINUTES = int(os.getenv("LOCKOUT_DURATION_MINUTES", "30"))


class PostgresAuthService:
    """Service class for PostgreSQL-based authentication operations."""

    def __init__(self):
        self.db = get_db()

    # =========================================================================
    # Password Operations
    # =========================================================================

    @staticmethod
    def hash_password(password: str) -> str:
        """Hash a password using bcrypt."""
        return pwd_context.hash(password)

    @staticmethod
    def verify_password(plain_password: str, hashed_password: str) -> bool:
        """Verify a password against a hash."""
        try:
            return pwd_context.verify(plain_password, hashed_password)
        except Exception as e:
            logger.error(f"Password verification error: {e}")
            return False

    # =========================================================================
    # Token Operations
    # =========================================================================

    @staticmethod
    def generate_secure_token(length: int = 64) -> str:
        """Generate a cryptographically secure random token."""
        return secrets.token_urlsafe(length)

    @staticmethod
    def hash_token(token: str) -> str:
        """Hash a token for secure storage."""
        return hashlib.sha256(token.encode()).hexdigest()

    def create_access_token(
        self,
        user_id: str,
        email: str,
        expires_delta: Optional[timedelta] = None
    ) -> str:
        """Create a JWT access token."""
        if expires_delta is None:
            expires_delta = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)

        now = datetime.utcnow()
        expire = now + expires_delta

        payload = {
            "sub": str(user_id),
            "email": email,
            "type": "access",
            "exp": expire,
            "iat": now,
        }

        return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)

    def create_refresh_token(
        self,
        user_id: str,
        email: str,
        expires_delta: Optional[timedelta] = None
    ) -> Tuple[str, str]:
        """
        Create a refresh token.
        Returns (token, token_hash) - store the hash, return the token to client.
        """
        if expires_delta is None:
            expires_delta = timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)

        token = self.generate_secure_token()
        token_hash = self.hash_token(token)
        now = datetime.utcnow()
        expire = now + expires_delta

        # Also create a JWT for the refresh token
        payload = {
            "sub": str(user_id),
            "email": email,
            "type": "refresh",
            "jti": token_hash[:32],  # JWT ID
            "exp": expire,
            "iat": now,
        }

        jwt_refresh = jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)
        return jwt_refresh, token_hash

    def decode_token(self, token: str) -> Optional[dict]:
        """Decode and validate a JWT token."""
        try:
            payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
            return payload
        except jwt.ExpiredSignatureError:
            logger.warning("Token has expired")
            return None
        except jwt.JWTError as e:
            logger.warning(f"Invalid token: {e}")
            return None

    # =========================================================================
    # User Registration
    # =========================================================================

    async def register_user(
        self,
        email: str,
        password: str,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None
    ) -> Tuple[Optional[dict], Optional[str]]:
        """
        Register a new user.
        Returns (user_data, error_message).
        """
        email = email.lower().strip()

        # Check if user already exists
        existing = await self.get_user_by_email(email)
        if existing:
            return None, "A user with this email already exists"

        # Hash password
        password_hash = self.hash_password(password)

        # Generate display name
        display_name = None
        if first_name and last_name:
            display_name = f"{first_name} {last_name}"
        elif first_name:
            display_name = first_name

        query = """
            INSERT INTO users (email, password_hash, first_name, last_name, display_name)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, email, first_name, last_name, display_name, email_verified,
                      is_active, created_at, last_login_at, avatar_url
        """

        try:
            user = await self.db.execute_one_async(
                query, email, password_hash, first_name, last_name, display_name
            )

            # Create default preferences
            await self._create_default_preferences(user['id'])

            logger.info(f"User registered: {email}")
            return dict(user), None

        except Exception as e:
            logger.error(f"Registration error: {e}")
            return None, "Registration failed. Please try again."

    async def _create_default_preferences(self, user_id: UUID) -> None:
        """Create default preferences for a new user."""
        query = """
            INSERT INTO user_preferences (user_id)
            VALUES ($1)
            ON CONFLICT (user_id) DO NOTHING
        """
        try:
            await self.db.execute_async(query, user_id)
        except Exception as e:
            logger.error(f"Failed to create default preferences: {e}")

    # =========================================================================
    # User Authentication
    # =========================================================================

    async def authenticate_user(
        self,
        email: str,
        password: str,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None
    ) -> Tuple[Optional[dict], Optional[str]]:
        """
        Authenticate a user by email and password.
        Returns (user_data, error_message).
        """
        email = email.lower().strip()

        # Get user
        user = await self.get_user_by_email(email, include_password=True)

        # Log attempt
        success = False
        failure_reason = None

        if not user:
            failure_reason = "user_not_found"
            await self._log_login_attempt(email, ip_address, user_agent, False, failure_reason)
            return None, "Invalid email or password"

        # Check if account is locked
        if user.get('locked_until'):
            if datetime.utcnow() < user['locked_until']:
                failure_reason = "account_locked"
                await self._log_login_attempt(email, ip_address, user_agent, False, failure_reason)
                return None, "Account is temporarily locked. Please try again later."

        # Check if account is active
        if not user.get('is_active', True):
            failure_reason = "account_inactive"
            await self._log_login_attempt(email, ip_address, user_agent, False, failure_reason)
            return None, "Account is not active. Please contact support."

        # Check if email is verified (optional - can be configured)
        # if not user.get('email_verified', False):
        #     return None, "Please verify your email before logging in"

        # Verify password
        if not user.get('password_hash'):
            failure_reason = "oauth_only_account"
            await self._log_login_attempt(email, ip_address, user_agent, False, failure_reason)
            return None, "This account uses social login. Please use 'Continue with Google'."

        if not self.verify_password(password, user['password_hash']):
            failure_reason = "invalid_password"
            await self._increment_failed_attempts(user['id'])
            await self._log_login_attempt(email, ip_address, user_agent, False, failure_reason)
            return None, "Invalid email or password"

        # Successful login
        success = True
        await self._reset_failed_attempts(user['id'])
        await self._update_last_login(user['id'], ip_address)
        await self._log_login_attempt(email, ip_address, user_agent, True, None)

        # Remove sensitive data before returning
        user.pop('password_hash', None)
        logger.info(f"User authenticated: {email}")

        return user, None

    async def _log_login_attempt(
        self,
        email: str,
        ip_address: Optional[str],
        user_agent: Optional[str],
        success: bool,
        failure_reason: Optional[str]
    ) -> None:
        """Log a login attempt for security monitoring."""
        query = """
            INSERT INTO login_attempts (email, ip_address, user_agent, success, failure_reason)
            VALUES ($1, $2::inet, $3, $4, $5)
        """
        try:
            ip = ip_address if ip_address else '0.0.0.0'
            await self.db.execute_async(query, email, ip, user_agent, success, failure_reason)
        except Exception as e:
            logger.error(f"Failed to log login attempt: {e}")

    async def _increment_failed_attempts(self, user_id: UUID) -> None:
        """Increment failed login attempts and lock if necessary."""
        query = """
            UPDATE users
            SET failed_login_attempts = failed_login_attempts + 1,
                locked_until = CASE
                    WHEN failed_login_attempts + 1 >= $2
                    THEN CURRENT_TIMESTAMP + INTERVAL '%s minutes'
                    ELSE NULL
                END
            WHERE id = $1
        """ % LOCKOUT_DURATION_MINUTES
        try:
            await self.db.execute_async(query, user_id, MAX_LOGIN_ATTEMPTS)
        except Exception as e:
            logger.error(f"Failed to increment failed attempts: {e}")

    async def _reset_failed_attempts(self, user_id: UUID) -> None:
        """Reset failed login attempts on successful login."""
        query = """
            UPDATE users
            SET failed_login_attempts = 0, locked_until = NULL
            WHERE id = $1
        """
        try:
            await self.db.execute_async(query, user_id)
        except Exception as e:
            logger.error(f"Failed to reset failed attempts: {e}")

    async def _update_last_login(self, user_id: UUID, ip_address: Optional[str]) -> None:
        """Update last login timestamp and IP."""
        query = """
            UPDATE users
            SET last_login_at = CURRENT_TIMESTAMP,
                last_login_ip = $2::inet
            WHERE id = $1
        """
        try:
            ip = ip_address if ip_address else None
            await self.db.execute_async(query, user_id, ip)
        except Exception as e:
            logger.error(f"Failed to update last login: {e}")

    # =========================================================================
    # User Retrieval
    # =========================================================================

    async def get_user_by_id(
        self,
        user_id: UUID,
        include_password: bool = False
    ) -> Optional[dict]:
        """Get a user by their ID."""
        fields = """
            id, email, first_name, last_name, display_name, avatar_url,
            email_verified, is_active, is_superuser, failed_login_attempts,
            locked_until, last_login_at, last_login_ip, created_at, updated_at
        """
        if include_password:
            fields += ", password_hash"

        query = f"SELECT {fields} FROM users WHERE id = $1"

        try:
            user = await self.db.execute_one_async(query, user_id)
            return dict(user) if user else None
        except Exception as e:
            logger.error(f"Error getting user by id: {e}")
            return None

    async def get_user_by_email(
        self,
        email: str,
        include_password: bool = False
    ) -> Optional[dict]:
        """Get a user by their email."""
        email = email.lower().strip()

        fields = """
            id, email, first_name, last_name, display_name, avatar_url,
            email_verified, is_active, is_superuser, failed_login_attempts,
            locked_until, last_login_at, last_login_ip, created_at, updated_at
        """
        if include_password:
            fields += ", password_hash"

        query = f"SELECT {fields} FROM users WHERE email = $1"

        try:
            user = await self.db.execute_one_async(query, email)
            return dict(user) if user else None
        except Exception as e:
            logger.error(f"Error getting user by email: {e}")
            return None

    # =========================================================================
    # Email Verification
    # =========================================================================

    async def create_email_verification_token(
        self,
        user_id: UUID,
        expires_hours: int = 24
    ) -> Optional[str]:
        """Create an email verification token."""
        token = self.generate_secure_token(32)
        expires_at = datetime.utcnow() + timedelta(hours=expires_hours)

        query = """
            INSERT INTO email_verification_tokens (user_id, token, expires_at)
            VALUES ($1, $2, $3)
            RETURNING token
        """

        try:
            result = await self.db.execute_one_async(query, user_id, token, expires_at)
            return result['token'] if result else None
        except Exception as e:
            logger.error(f"Error creating verification token: {e}")
            return None

    async def verify_email_token(self, token: str) -> Tuple[Optional[dict], Optional[str]]:
        """
        Verify an email verification token.
        Returns (user, error_message).
        """
        query = """
            SELECT evt.id, evt.user_id, evt.expires_at, evt.used_at,
                   u.email, u.email_verified
            FROM email_verification_tokens evt
            JOIN users u ON evt.user_id = u.id
            WHERE evt.token = $1
        """

        try:
            result = await self.db.execute_one_async(query, token)

            if not result:
                return None, "Invalid verification token"

            if result['used_at']:
                return None, "This verification link has already been used"

            if datetime.utcnow() > result['expires_at']:
                return None, "Verification link has expired"

            if result['email_verified']:
                return None, "Email is already verified"

            # Mark token as used and verify email
            await self._mark_email_verified(result['user_id'], result['id'])

            user = await self.get_user_by_id(result['user_id'])
            return user, None

        except Exception as e:
            logger.error(f"Error verifying email token: {e}")
            return None, "Verification failed"

    async def _mark_email_verified(self, user_id: UUID, token_id: UUID) -> None:
        """Mark user's email as verified and consume the token."""
        queries = [
            (
                "UPDATE users SET email_verified = TRUE, email_verified_at = CURRENT_TIMESTAMP WHERE id = $1",
                (user_id,)
            ),
            (
                "UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1",
                (token_id,)
            )
        ]
        await self.db.execute_transaction_async(queries)
        logger.info(f"Email verified for user: {user_id}")

    # =========================================================================
    # Password Reset
    # =========================================================================

    async def create_password_reset_token(
        self,
        email: str,
        expires_hours: int = 1
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Create a password reset token.
        Returns (token, error_message).
        """
        user = await self.get_user_by_email(email)
        if not user:
            # Don't reveal whether email exists
            return None, None

        token = self.generate_secure_token(32)
        expires_at = datetime.utcnow() + timedelta(hours=expires_hours)

        query = """
            INSERT INTO password_reset_tokens (user_id, token, expires_at)
            VALUES ($1, $2, $3)
            RETURNING token
        """

        try:
            result = await self.db.execute_one_async(query, user['id'], token, expires_at)
            logger.info(f"Password reset token created for: {email}")
            return result['token'] if result else None, None
        except Exception as e:
            logger.error(f"Error creating password reset token: {e}")
            return None, "Failed to create reset token"

    async def reset_password(
        self,
        token: str,
        new_password: str
    ) -> Tuple[bool, Optional[str]]:
        """
        Reset password using a reset token.
        Returns (success, error_message).
        """
        query = """
            SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at
            FROM password_reset_tokens prt
            WHERE prt.token = $1
        """

        try:
            result = await self.db.execute_one_async(query, token)

            if not result:
                return False, "Invalid reset token"

            if result['used_at']:
                return False, "This reset link has already been used"

            if datetime.utcnow() > result['expires_at']:
                return False, "Reset link has expired"

            # Hash new password and update
            password_hash = self.hash_password(new_password)

            queries = [
                (
                    "UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
                    (password_hash, result['user_id'])
                ),
                (
                    "UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1",
                    (result['id'],)
                )
            ]
            await self.db.execute_transaction_async(queries)

            logger.info(f"Password reset completed for user: {result['user_id']}")
            return True, None

        except Exception as e:
            logger.error(f"Error resetting password: {e}")
            return False, "Password reset failed"

    async def change_password(
        self,
        user_id: UUID,
        current_password: str,
        new_password: str
    ) -> Tuple[bool, Optional[str]]:
        """
        Change password for a logged-in user.
        Returns (success, error_message).
        """
        user = await self.get_user_by_id(user_id, include_password=True)

        if not user:
            return False, "User not found"

        if not user.get('password_hash'):
            return False, "Cannot change password for OAuth-only accounts"

        if not self.verify_password(current_password, user['password_hash']):
            return False, "Current password is incorrect"

        password_hash = self.hash_password(new_password)

        query = """
            UPDATE users
            SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        """

        try:
            await self.db.execute_async(query, password_hash, user_id)
            logger.info(f"Password changed for user: {user_id}")
            return True, None
        except Exception as e:
            logger.error(f"Error changing password: {e}")
            return False, "Password change failed"

    # =========================================================================
    # Refresh Token Management
    # =========================================================================

    async def store_refresh_token(
        self,
        user_id: UUID,
        token_hash: str,
        device_info: Optional[dict] = None,
        ip_address: Optional[str] = None,
        expires_days: int = None
    ) -> bool:
        """Store a refresh token hash in the database."""
        if expires_days is None:
            expires_days = REFRESH_TOKEN_EXPIRE_DAYS

        expires_at = datetime.utcnow() + timedelta(days=expires_days)

        query = """
            INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
            VALUES ($1, $2, $3, $4::inet, $5)
        """

        try:
            ip = ip_address if ip_address else None
            await self.db.execute_async(
                query, user_id, token_hash,
                device_info, ip, expires_at
            )
            return True
        except Exception as e:
            logger.error(f"Error storing refresh token: {e}")
            return False

    async def validate_refresh_token(self, token_hash: str) -> Optional[dict]:
        """Validate a refresh token and return the associated user."""
        query = """
            SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
                   u.email, u.is_active
            FROM refresh_tokens rt
            JOIN users u ON rt.user_id = u.id
            WHERE rt.token_hash = $1
        """

        try:
            result = await self.db.execute_one_async(query, token_hash)

            if not result:
                return None

            if result['revoked_at']:
                return None

            if datetime.utcnow() > result['expires_at']:
                return None

            if not result['is_active']:
                return None

            return dict(result)

        except Exception as e:
            logger.error(f"Error validating refresh token: {e}")
            return None

    async def revoke_refresh_token(self, token_hash: str) -> bool:
        """Revoke a specific refresh token."""
        query = """
            UPDATE refresh_tokens
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE token_hash = $1
        """
        try:
            await self.db.execute_async(query, token_hash)
            return True
        except Exception as e:
            logger.error(f"Error revoking refresh token: {e}")
            return False

    async def revoke_all_user_tokens(self, user_id: UUID) -> bool:
        """Revoke all refresh tokens for a user (logout all devices)."""
        query = """
            UPDATE refresh_tokens
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE user_id = $1 AND revoked_at IS NULL
        """
        try:
            await self.db.execute_async(query, user_id)
            logger.info(f"All tokens revoked for user: {user_id}")
            return True
        except Exception as e:
            logger.error(f"Error revoking all tokens: {e}")
            return False

    # =========================================================================
    # Profile Management
    # =========================================================================

    async def update_profile(
        self,
        user_id: UUID,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        display_name: Optional[str] = None,
        avatar_url: Optional[str] = None
    ) -> Optional[dict]:
        """Update user profile information."""
        updates = []
        values = []
        param_count = 1

        if first_name is not None:
            updates.append(f"first_name = ${param_count}")
            values.append(first_name)
            param_count += 1

        if last_name is not None:
            updates.append(f"last_name = ${param_count}")
            values.append(last_name)
            param_count += 1

        if display_name is not None:
            updates.append(f"display_name = ${param_count}")
            values.append(display_name)
            param_count += 1

        if avatar_url is not None:
            updates.append(f"avatar_url = ${param_count}")
            values.append(avatar_url)
            param_count += 1

        if not updates:
            return await self.get_user_by_id(user_id)

        values.append(user_id)
        query = f"""
            UPDATE users
            SET {', '.join(updates)}, updated_at = CURRENT_TIMESTAMP
            WHERE id = ${param_count}
            RETURNING id, email, first_name, last_name, display_name, avatar_url,
                      email_verified, is_active, created_at, last_login_at
        """

        try:
            user = await self.db.execute_one_async(query, *values)
            return dict(user) if user else None
        except Exception as e:
            logger.error(f"Error updating profile: {e}")
            return None

    async def get_user_preferences(self, user_id: UUID) -> Optional[dict]:
        """Get user preferences."""
        query = """
            SELECT theme, language, ai_mode, notifications_enabled, preferences_data
            FROM user_preferences
            WHERE user_id = $1
        """
        try:
            result = await self.db.execute_one_async(query, user_id)
            return dict(result) if result else None
        except Exception as e:
            logger.error(f"Error getting preferences: {e}")
            return None

    async def update_user_preferences(
        self,
        user_id: UUID,
        theme: Optional[str] = None,
        language: Optional[str] = None,
        ai_mode: Optional[str] = None,
        notifications_enabled: Optional[bool] = None
    ) -> Optional[dict]:
        """Update user preferences."""
        updates = []
        values = []
        param_count = 1

        if theme is not None:
            updates.append(f"theme = ${param_count}")
            values.append(theme)
            param_count += 1

        if language is not None:
            updates.append(f"language = ${param_count}")
            values.append(language)
            param_count += 1

        if ai_mode is not None:
            updates.append(f"ai_mode = ${param_count}")
            values.append(ai_mode)
            param_count += 1

        if notifications_enabled is not None:
            updates.append(f"notifications_enabled = ${param_count}")
            values.append(notifications_enabled)
            param_count += 1

        if not updates:
            return await self.get_user_preferences(user_id)

        values.append(user_id)
        query = f"""
            UPDATE user_preferences
            SET {', '.join(updates)}, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ${param_count}
            RETURNING theme, language, ai_mode, notifications_enabled, preferences_data
        """

        try:
            result = await self.db.execute_one_async(query, *values)
            return dict(result) if result else None
        except Exception as e:
            logger.error(f"Error updating preferences: {e}")
            return None

    # =========================================================================
    # Rate Limiting
    # =========================================================================

    async def check_rate_limit(
        self,
        email: str,
        ip_address: str,
        window_minutes: int = 15,
        max_attempts: int = 5
    ) -> Tuple[bool, int]:
        """
        Check if login attempts are within rate limit.
        Returns (is_allowed, remaining_attempts).
        """
        query = """
            SELECT COUNT(*) as attempt_count
            FROM login_attempts
            WHERE (email = $1 OR ip_address = $2::inet)
              AND success = FALSE
              AND attempted_at > CURRENT_TIMESTAMP - INTERVAL '%s minutes'
        """ % window_minutes

        try:
            result = await self.db.execute_one_async(query, email, ip_address)
            attempt_count = result['attempt_count'] if result else 0
            remaining = max(0, max_attempts - attempt_count)
            is_allowed = attempt_count < max_attempts

            return is_allowed, remaining

        except Exception as e:
            logger.error(f"Error checking rate limit: {e}")
            # Allow on error (fail open)
            return True, max_attempts


# Global instance
_postgres_auth_service = None


def get_postgres_auth_service() -> PostgresAuthService:
    """Get the PostgreSQL auth service instance."""
    global _postgres_auth_service
    if _postgres_auth_service is None:
        _postgres_auth_service = PostgresAuthService()
    return _postgres_auth_service
