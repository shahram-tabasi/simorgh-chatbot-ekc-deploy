"""
User Tier Service

Manages user tiers, quotas, and daily usage tracking.
Legacy (TPMS) users bypass all checks - unlimited access.
Modern users are subject to tier-based limits.
"""

import os
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from uuid import UUID

logger = logging.getLogger(__name__)

ADMIN_SETUP_SECRET = os.getenv("ADMIN_SETUP_SECRET", "")


class UserTierService:
    """Service for managing user tiers and quotas."""

    def __init__(self, db):
        self.db = db

    # =========================================================================
    # Tier Quota Lookups
    # =========================================================================

    async def get_tier_quotas(self, tier_name: str) -> Optional[dict]:
        """Get quota configuration for a tier."""
        query = """
            SELECT tier_name, max_questions_per_day, can_create_projects,
                   can_use_offline_llm, can_use_tools, subscription_duration_days,
                   description
            FROM tier_quotas
            WHERE tier_name = $1
        """
        try:
            result = await self.db.execute_one_async(query, tier_name)
            return dict(result) if result else None
        except Exception as e:
            logger.error(f"Error getting tier quotas for {tier_name}: {e}")
            return None

    async def get_all_tier_quotas(self) -> list:
        """Get all tier quota configurations."""
        query = "SELECT * FROM tier_quotas ORDER BY max_questions_per_day ASC"
        try:
            results = await self.db.execute_async(query)
            return [dict(r) for r in results] if results else []
        except Exception as e:
            logger.error(f"Error getting all tier quotas: {e}")
            return []

    # =========================================================================
    # Daily Usage Tracking
    # =========================================================================

    async def get_daily_usage(self, user_id: UUID) -> int:
        """Get today's question count for a user."""
        query = """
            SELECT questions_used FROM user_daily_usage
            WHERE user_id = $1 AND usage_date = CURRENT_DATE
        """
        try:
            result = await self.db.execute_one_async(query, user_id)
            return result['questions_used'] if result else 0
        except Exception as e:
            logger.error(f"Error getting daily usage for {user_id}: {e}")
            return 0

    async def increment_usage(self, user_id: UUID, amount: int = 1) -> int:
        """Increment daily question count. Returns new count."""
        query = """
            INSERT INTO user_daily_usage (user_id, usage_date, questions_used)
            VALUES ($1, CURRENT_DATE, $2)
            ON CONFLICT (user_id, usage_date)
            DO UPDATE SET questions_used = user_daily_usage.questions_used + $2,
                         updated_at = CURRENT_TIMESTAMP
            RETURNING questions_used
        """
        try:
            result = await self.db.execute_one_async(query, user_id, amount)
            return result['questions_used'] if result else 0
        except Exception as e:
            logger.error(f"Error incrementing usage for {user_id}: {e}")
            return 0

    # =========================================================================
    # Quota Checking
    # =========================================================================

    async def check_quota(self, user_id: UUID, user_role: str) -> Tuple[bool, dict]:
        """
        Check if a modern user has remaining quota.
        Returns (allowed, quota_info).
        """
        # Get tier limits
        quotas = await self.get_tier_quotas(user_role)
        if not quotas:
            # Unknown tier, default to free
            quotas = await self.get_tier_quotas('free')
            if not quotas:
                # tier_quotas table might be empty
                return True, {"questions_limit": 20, "questions_used": 0, "questions_remaining": 20}

        max_per_day = quotas['max_questions_per_day']
        current_usage = await self.get_daily_usage(user_id)
        remaining = max(0, max_per_day - current_usage)

        # Calculate reset time (next midnight UTC)
        now = datetime.now(timezone.utc)
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)

        quota_info = {
            "user_role": user_role,
            "questions_used": current_usage,
            "questions_limit": max_per_day,
            "questions_remaining": remaining,
            "can_create_projects": quotas['can_create_projects'],
            "can_use_offline_llm": quotas['can_use_offline_llm'],
            "can_use_tools": quotas['can_use_tools'],
            "resets_at": tomorrow.isoformat(),
        }

        allowed = current_usage < max_per_day
        return allowed, quota_info

    async def get_quota_status(self, user_id: UUID, user_role: str,
                                subscription_expires_at: Optional[datetime] = None) -> dict:
        """Get full quota status for a user (for API response)."""
        _, quota_info = await self.check_quota(user_id, user_role)

        # Check subscription expiry for pro/max
        subscription_active = True
        if user_role in ('pro', 'max') and subscription_expires_at:
            now = datetime.now(timezone.utc)
            if subscription_expires_at.tzinfo is None:
                subscription_expires_at = subscription_expires_at.replace(tzinfo=timezone.utc)
            subscription_active = subscription_expires_at > now

        quota_info["subscription_expires_at"] = subscription_expires_at.isoformat() if subscription_expires_at else None
        quota_info["subscription_active"] = subscription_active

        return quota_info

    # =========================================================================
    # Tier Management
    # =========================================================================

    async def upgrade_user(self, user_id: UUID, new_role: str,
                           subscription_days: Optional[int] = None) -> Optional[dict]:
        """Upgrade a user's tier."""
        expires_at = None
        if subscription_days:
            expires_at = datetime.now(timezone.utc) + timedelta(days=subscription_days)
        elif new_role in ('pro', 'max'):
            # Default subscription duration from tier config
            quotas = await self.get_tier_quotas(new_role)
            if quotas and quotas.get('subscription_duration_days'):
                expires_at = datetime.now(timezone.utc) + timedelta(days=quotas['subscription_duration_days'])

        query = """
            UPDATE users
            SET user_role = $1, subscription_expires_at = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING id, email, user_role, subscription_expires_at
        """
        try:
            result = await self.db.execute_one_async(query, new_role, expires_at, user_id)
            if result:
                logger.info(f"User {user_id} upgraded to {new_role} (expires: {expires_at})")
                return dict(result)
            return None
        except Exception as e:
            logger.error(f"Error upgrading user {user_id} to {new_role}: {e}")
            return None

    async def check_expired_subscriptions(self) -> int:
        """Downgrade expired pro/max users to free. Returns count of downgraded users."""
        query = """
            UPDATE users
            SET user_role = 'free', subscription_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE user_role IN ('pro', 'max')
              AND subscription_expires_at IS NOT NULL
              AND subscription_expires_at < CURRENT_TIMESTAMP
            RETURNING id, email
        """
        try:
            results = await self.db.execute_async(query)
            if results:
                for r in results:
                    logger.info(f"Subscription expired, downgraded to free: {r['email']}")
                return len(results)
            return 0
        except Exception as e:
            logger.error(f"Error checking expired subscriptions: {e}")
            return 0

    # =========================================================================
    # Admin Setup
    # =========================================================================

    async def setup_admin(self, user_id: UUID, admin_secret: str) -> Tuple[bool, str]:
        """Promote a user to admin with the setup secret."""
        if not ADMIN_SETUP_SECRET:
            return False, "Admin setup secret not configured on server"

        if admin_secret != ADMIN_SETUP_SECRET:
            return False, "Invalid admin secret"

        query = """
            UPDATE users
            SET user_role = 'admin', is_superuser = TRUE, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING id, email
        """
        try:
            result = await self.db.execute_one_async(query, user_id)
            if result:
                logger.info(f"Admin setup: {result['email']} promoted to admin")
                return True, f"User {result['email']} is now an admin"
            return False, "User not found"
        except Exception as e:
            logger.error(f"Error setting up admin: {e}")
            return False, f"Error: {e}"

    # =========================================================================
    # Tier Quota Administration
    # =========================================================================

    async def update_tier_quotas(self, tier_name: str, **kwargs) -> Optional[dict]:
        """Update quota configuration for a tier."""
        updates = []
        values = []
        param_count = 1

        for field in ('max_questions_per_day', 'can_create_projects',
                      'can_use_offline_llm', 'can_use_tools',
                      'subscription_duration_days', 'description'):
            if field in kwargs and kwargs[field] is not None:
                updates.append(f"{field} = ${param_count}")
                values.append(kwargs[field])
                param_count += 1

        if not updates:
            return await self.get_tier_quotas(tier_name)

        values.append(tier_name)
        query = f"""
            UPDATE tier_quotas
            SET {', '.join(updates)}, updated_at = CURRENT_TIMESTAMP
            WHERE tier_name = ${param_count}
            RETURNING *
        """
        try:
            result = await self.db.execute_one_async(query, *values)
            return dict(result) if result else None
        except Exception as e:
            logger.error(f"Error updating tier quotas for {tier_name}: {e}")
            return None


# =============================================================================
# Singleton
# =============================================================================

_tier_service: Optional[UserTierService] = None


def get_tier_service() -> Optional[UserTierService]:
    """Get the tier service singleton. Must be initialized after DB is ready."""
    return _tier_service


def init_tier_service(db) -> UserTierService:
    """Initialize the tier service with a database connection."""
    global _tier_service
    _tier_service = UserTierService(db)
    return _tier_service
