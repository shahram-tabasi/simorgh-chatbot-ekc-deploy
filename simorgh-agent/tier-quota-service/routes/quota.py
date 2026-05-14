"""
Quota Routes

Endpoints for users to check their quota status and tier info.
Admin endpoints for tier management are in admin.py (Phase 4).
"""

import logging
from uuid import UUID

from fastapi import APIRouter, HTTPException, Depends

from services.auth_utils import get_current_user
from services.user_tier_service import get_tier_service
from models.tier_models import QuotaStatusResponse, TierQuotaInfo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/quota", tags=["Quota"])


@router.get("/me", response_model=QuotaStatusResponse)
async def get_my_quota(current_user: dict = Depends(get_current_user)):
    """
    Get current user's quota status.

    Returns daily usage, limits, remaining questions, and feature access.
    """
    tier_service = get_tier_service()
    if not tier_service:
        # Service not initialized - return defaults
        return QuotaStatusResponse()

    user_id = current_user["id"]
    user_role = current_user.get("user_role", "free")
    subscription_expires_at = current_user.get("subscription_expires_at")

    quota_info = await tier_service.get_quota_status(
        user_id, user_role, subscription_expires_at
    )

    return QuotaStatusResponse(
        user_role=quota_info.get("user_role", user_role),
        questions_used_today=quota_info.get("questions_used", 0),
        questions_limit=quota_info.get("questions_limit", 20),
        questions_remaining=quota_info.get("questions_remaining", 20),
        can_create_projects=quota_info.get("can_create_projects", False),
        can_use_offline_llm=quota_info.get("can_use_offline_llm", False),
        can_use_tools=quota_info.get("can_use_tools", False),
        subscription_expires_at=subscription_expires_at,
        subscription_active=quota_info.get("subscription_active", True),
        resets_at=quota_info.get("resets_at", ""),
    )


@router.get("/tiers", response_model=list[TierQuotaInfo])
async def get_all_tiers():
    """
    Get all available tier configurations.

    Public endpoint - shows what each tier offers.
    """
    tier_service = get_tier_service()
    if not tier_service:
        return []

    tiers = await tier_service.get_all_tier_quotas()
    return [
        TierQuotaInfo(
            tier_name=t["tier_name"],
            max_questions_per_day=t["max_questions_per_day"],
            can_create_projects=t.get("can_create_projects", False),
            can_use_offline_llm=t.get("can_use_offline_llm", False),
            can_use_tools=t.get("can_use_tools", False),
            subscription_duration_days=t.get("subscription_duration_days"),
            description=t.get("description"),
        )
        for t in tiers
    ]
