"""
OAuth Service

Handles OAuth 2.0 authentication with external providers (Google, etc.).
"""

import os
import logging
from typing import Optional, Tuple
from uuid import UUID
import aiohttp
from dataclasses import dataclass

from database.postgres_connection import get_db
from services.postgres_auth_service import get_postgres_auth_service

logger = logging.getLogger(__name__)


# =============================================================================
# OAuth Configuration
# =============================================================================

# Google OAuth
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:5173/auth/google/callback")

# OAuth URLs
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


@dataclass
class OAuthUserInfo:
    """User information from OAuth provider."""
    provider: str
    provider_user_id: str
    email: str
    email_verified: bool
    first_name: Optional[str]
    last_name: Optional[str]
    display_name: Optional[str]
    avatar_url: Optional[str]
    raw_data: dict


class OAuthService:
    """Service for handling OAuth authentication flows."""

    def __init__(self):
        self.db = get_db()
        self.auth_service = get_postgres_auth_service()

    # =========================================================================
    # Google OAuth
    # =========================================================================

    def get_google_auth_url(
        self,
        redirect_uri: Optional[str] = None,
        state: Optional[str] = None
    ) -> str:
        """Generate the Google OAuth authorization URL."""
        if not GOOGLE_CLIENT_ID:
            raise ValueError("Google OAuth is not configured")

        uri = redirect_uri or GOOGLE_REDIRECT_URI

        params = {
            "client_id": GOOGLE_CLIENT_ID,
            "redirect_uri": uri,
            "response_type": "code",
            "scope": "openid email profile",
            "access_type": "offline",
            "prompt": "consent",
        }

        if state:
            params["state"] = state

        query = "&".join(f"{k}={v}" for k, v in params.items())
        return f"{GOOGLE_AUTH_URL}?{query}"

    async def exchange_google_code(
        self,
        code: str,
        redirect_uri: Optional[str] = None
    ) -> Tuple[Optional[dict], Optional[str]]:
        """
        Exchange Google OAuth code for tokens.
        Returns (tokens, error_message).
        """
        if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
            return None, "Google OAuth is not configured"

        uri = redirect_uri or GOOGLE_REDIRECT_URI

        data = {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": uri,
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(GOOGLE_TOKEN_URL, data=data) as response:
                    if response.status != 200:
                        error = await response.text()
                        logger.error(f"Google token exchange failed: {error}")
                        return None, "Failed to authenticate with Google"

                    tokens = await response.json()
                    return tokens, None

        except Exception as e:
            logger.error(f"Google OAuth error: {e}")
            return None, "Failed to connect to Google"

    async def get_google_user_info(
        self,
        access_token: str
    ) -> Tuple[Optional[OAuthUserInfo], Optional[str]]:
        """
        Get user information from Google using access token.
        Returns (user_info, error_message).
        """
        headers = {"Authorization": f"Bearer {access_token}"}

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(GOOGLE_USERINFO_URL, headers=headers) as response:
                    if response.status != 200:
                        error = await response.text()
                        logger.error(f"Failed to get Google user info: {error}")
                        return None, "Failed to get user information from Google"

                    data = await response.json()

                    user_info = OAuthUserInfo(
                        provider="google",
                        provider_user_id=data.get("sub"),
                        email=data.get("email", "").lower(),
                        email_verified=data.get("email_verified", False),
                        first_name=data.get("given_name"),
                        last_name=data.get("family_name"),
                        display_name=data.get("name"),
                        avatar_url=data.get("picture"),
                        raw_data=data
                    )

                    return user_info, None

        except Exception as e:
            logger.error(f"Google user info error: {e}")
            return None, "Failed to get user information"

    # =========================================================================
    # OAuth Account Management
    # =========================================================================

    async def authenticate_with_google(
        self,
        code: str,
        redirect_uri: Optional[str] = None,
        ip_address: Optional[str] = None
    ) -> Tuple[Optional[dict], Optional[str]]:
        """
        Complete Google OAuth flow and return user with tokens.
        Returns (auth_result, error_message).
        """
        # Exchange code for tokens
        tokens, error = await self.exchange_google_code(code, redirect_uri)
        if error:
            return None, error

        access_token = tokens.get("access_token")
        if not access_token:
            return None, "Invalid token response from Google"

        # Get user info from Google
        user_info, error = await self.get_google_user_info(access_token)
        if error:
            return None, error

        if not user_info.email:
            return None, "Email not provided by Google"

        # Find or create user
        user, error = await self._find_or_create_oauth_user(
            user_info,
            access_token=access_token,
            refresh_token=tokens.get("refresh_token"),
            ip_address=ip_address
        )

        if error:
            return None, error

        # Generate our tokens
        jwt_access = self.auth_service.create_access_token(
            str(user['id']), user['email']
        )
        jwt_refresh, refresh_hash = self.auth_service.create_refresh_token(
            str(user['id']), user['email']
        )

        # Store refresh token
        await self.auth_service.store_refresh_token(
            user['id'],
            refresh_hash,
            device_info={"auth_method": "google_oauth"},
            ip_address=ip_address
        )

        return {
            "access_token": jwt_access,
            "refresh_token": jwt_refresh,
            "token_type": "bearer",
            "user": user
        }, None

    async def _find_or_create_oauth_user(
        self,
        user_info: OAuthUserInfo,
        access_token: str,
        refresh_token: Optional[str] = None,
        ip_address: Optional[str] = None
    ) -> Tuple[Optional[dict], Optional[str]]:
        """
        Find existing user by OAuth account or email, or create new user.
        Links OAuth account if user exists with same email.
        """
        # First, check if OAuth account already exists
        oauth_account = await self._get_oauth_account(
            user_info.provider,
            user_info.provider_user_id
        )

        if oauth_account:
            # User exists with this OAuth account
            user = await self.auth_service.get_user_by_id(oauth_account['user_id'])
            if user:
                # Update OAuth tokens
                await self._update_oauth_tokens(
                    oauth_account['id'],
                    access_token,
                    refresh_token,
                    user_info.raw_data
                )
                return user, None

        # Check if user exists with this email
        existing_user = await self.auth_service.get_user_by_email(user_info.email)

        if existing_user:
            # Link OAuth account to existing user
            await self._create_oauth_account(
                existing_user['id'],
                user_info,
                access_token,
                refresh_token
            )

            # Update avatar if not set
            if not existing_user.get('avatar_url') and user_info.avatar_url:
                await self.auth_service.update_profile(
                    existing_user['id'],
                    avatar_url=user_info.avatar_url
                )
                existing_user['avatar_url'] = user_info.avatar_url

            return existing_user, None

        # Create new user
        user, error = await self._create_oauth_user(
            user_info,
            access_token,
            refresh_token,
            ip_address
        )

        return user, error

    async def _create_oauth_user(
        self,
        user_info: OAuthUserInfo,
        access_token: str,
        refresh_token: Optional[str] = None,
        ip_address: Optional[str] = None
    ) -> Tuple[Optional[dict], Optional[str]]:
        """Create a new user from OAuth data."""
        query = """
            INSERT INTO users (
                email, first_name, last_name, display_name, avatar_url,
                email_verified, email_verified_at, last_login_at, last_login_ip
            )
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $7::inet)
            RETURNING id, email, first_name, last_name, display_name, avatar_url,
                      email_verified, is_active, created_at, last_login_at
        """

        try:
            user = await self.db.execute_one_async(
                query,
                user_info.email,
                user_info.first_name,
                user_info.last_name,
                user_info.display_name,
                user_info.avatar_url,
                user_info.email_verified,
                ip_address
            )

            if not user:
                return None, "Failed to create user account"

            # Create OAuth account link
            await self._create_oauth_account(
                user['id'],
                user_info,
                access_token,
                refresh_token
            )

            # Create default preferences
            await self.auth_service._create_default_preferences(user['id'])

            logger.info(f"OAuth user created: {user_info.email} via {user_info.provider}")
            return dict(user), None

        except Exception as e:
            logger.error(f"Error creating OAuth user: {e}")
            return None, "Failed to create user account"

    async def _create_oauth_account(
        self,
        user_id: UUID,
        user_info: OAuthUserInfo,
        access_token: str,
        refresh_token: Optional[str] = None
    ) -> Optional[dict]:
        """Create an OAuth account link for a user."""
        query = """
            INSERT INTO oauth_accounts (
                user_id, provider, provider_user_id, provider_email,
                access_token, refresh_token, raw_user_data
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (provider, provider_user_id) DO UPDATE
            SET access_token = EXCLUDED.access_token,
                refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_accounts.refresh_token),
                raw_user_data = EXCLUDED.raw_user_data,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id
        """

        try:
            result = await self.db.execute_one_async(
                query,
                user_id,
                user_info.provider,
                user_info.provider_user_id,
                user_info.email,
                access_token,
                refresh_token,
                user_info.raw_data
            )
            return dict(result) if result else None

        except Exception as e:
            logger.error(f"Error creating OAuth account: {e}")
            return None

    async def _get_oauth_account(
        self,
        provider: str,
        provider_user_id: str
    ) -> Optional[dict]:
        """Get an OAuth account by provider and provider user ID."""
        query = """
            SELECT id, user_id, provider, provider_user_id, provider_email,
                   access_token, refresh_token, created_at
            FROM oauth_accounts
            WHERE provider = $1 AND provider_user_id = $2
        """

        try:
            result = await self.db.execute_one_async(query, provider, provider_user_id)
            return dict(result) if result else None
        except Exception as e:
            logger.error(f"Error getting OAuth account: {e}")
            return None

    async def _update_oauth_tokens(
        self,
        account_id: UUID,
        access_token: str,
        refresh_token: Optional[str] = None,
        raw_data: Optional[dict] = None
    ) -> None:
        """Update OAuth account tokens."""
        updates = ["access_token = $2", "updated_at = CURRENT_TIMESTAMP"]
        values = [account_id, access_token]
        param_count = 3

        if refresh_token:
            updates.append(f"refresh_token = ${param_count}")
            values.append(refresh_token)
            param_count += 1

        if raw_data:
            updates.append(f"raw_user_data = ${param_count}")
            values.append(raw_data)

        query = f"""
            UPDATE oauth_accounts
            SET {', '.join(updates)}
            WHERE id = $1
        """

        try:
            await self.db.execute_async(query, *values)
        except Exception as e:
            logger.error(f"Error updating OAuth tokens: {e}")

    async def get_user_oauth_providers(self, user_id: UUID) -> list:
        """Get all OAuth providers linked to a user."""
        query = """
            SELECT provider, provider_email, created_at
            FROM oauth_accounts
            WHERE user_id = $1
            ORDER BY created_at
        """

        try:
            results = await self.db.execute_async(query, user_id)
            return [dict(r) for r in results]
        except Exception as e:
            logger.error(f"Error getting OAuth providers: {e}")
            return []

    async def unlink_oauth_provider(
        self,
        user_id: UUID,
        provider: str
    ) -> Tuple[bool, Optional[str]]:
        """
        Unlink an OAuth provider from a user account.
        Returns (success, error_message).
        """
        # Check if user has a password set (can't unlink all auth methods)
        user = await self.auth_service.get_user_by_id(user_id, include_password=True)
        if not user:
            return False, "User not found"

        # Count OAuth providers
        providers = await self.get_user_oauth_providers(user_id)

        if len(providers) == 1 and not user.get('password_hash'):
            return False, "Cannot unlink the only authentication method. Set a password first."

        query = """
            DELETE FROM oauth_accounts
            WHERE user_id = $1 AND provider = $2
        """

        try:
            await self.db.execute_async(query, user_id, provider)
            logger.info(f"OAuth provider {provider} unlinked from user {user_id}")
            return True, None
        except Exception as e:
            logger.error(f"Error unlinking OAuth provider: {e}")
            return False, "Failed to unlink provider"


# Global instance
_oauth_service = None


def get_oauth_service() -> OAuthService:
    """Get the OAuth service instance."""
    global _oauth_service
    if _oauth_service is None:
        _oauth_service = OAuthService()
    return _oauth_service
