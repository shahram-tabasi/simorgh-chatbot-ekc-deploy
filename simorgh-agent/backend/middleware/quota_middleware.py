"""
Quota Enforcement Middleware

Per-user quota checking for modern (email/Google) users.
Legacy (TPMS) users bypass all checks - unlimited access.

Usage as a FastAPI dependency:
    @router.post("/chat/message")
    async def send_message(
        ...,
        quota_check: dict = Depends(check_user_quota)
    ):
"""

import logging
from typing import Optional
from uuid import UUID

from fastapi import Request, HTTPException, Depends
from starlette.responses import JSONResponse

from services.user_tier_service import get_tier_service

logger = logging.getLogger(__name__)


def _is_legacy_token(payload: dict) -> bool:
    """Check if the JWT payload belongs to a legacy (TPMS) user.

    Legacy tokens have a non-UUID 'sub' field (e.g. EMPUSERNAME string).
    Modern tokens have a UUID 'sub' field.
    """
    sub = payload.get("sub", "")
    try:
        UUID(sub)
        return False  # Valid UUID = modern user
    except (ValueError, AttributeError):
        return True  # Not a UUID = legacy user


async def check_user_quota(request: Request) -> dict:
    """
    FastAPI dependency that checks quota for the current user.

    Returns quota info dict on success.
    Raises HTTPException(429) if quota exceeded.
    Skips check for legacy (TPMS) users.

    Must be used AFTER authentication has set request.state.user.
    """
    # If user info was set by auth (modern user)
    user = getattr(request.state, "user", None)

    if not user:
        # No authenticated user context - let the endpoint handle auth
        return {"quota_check": "skipped", "reason": "no_user_context"}

    # Legacy users bypass all quota checks
    auth_method = getattr(request.state, "auth_method", None)
    if auth_method == "legacy":
        return {
            "quota_check": "bypassed",
            "reason": "legacy_user",
            "unlimited": True,
        }

    # Admin users have effectively unlimited quota
    user_role = user.get("user_role", "free")
    if user_role == "admin":
        return {
            "quota_check": "bypassed",
            "reason": "admin_user",
            "unlimited": True,
        }

    # Modern user - check tier quota
    tier_service = get_tier_service()
    if not tier_service:
        # Tier service not initialized - allow (fail open)
        logger.warning("Tier service not initialized, allowing request")
        return {"quota_check": "skipped", "reason": "tier_service_unavailable"}

    user_id = user.get("id")
    if not user_id:
        return {"quota_check": "skipped", "reason": "no_user_id"}

    if isinstance(user_id, str):
        user_id = UUID(user_id)

    allowed, quota_info = await tier_service.check_quota(user_id, user_role)

    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "error": "quota_exceeded",
                "message": f"Daily question limit reached ({quota_info['questions_limit']} questions). Resets at {quota_info['resets_at']}.",
                "questions_used": quota_info["questions_used"],
                "questions_limit": quota_info["questions_limit"],
                "resets_at": quota_info["resets_at"],
                "upgrade_url": "/upgrade",
            },
            headers={
                "X-Quota-Remaining": "0",
                "X-Quota-Limit": str(quota_info["questions_limit"]),
                "X-Quota-Reset": quota_info["resets_at"],
                "Retry-After": "3600",
            },
        )

    return quota_info


async def increment_user_usage(request: Request) -> None:
    """
    Increment daily usage count for the current user.
    Call this AFTER a successful chat response.
    Silently skips for legacy/admin users or if tier service unavailable.
    """
    user = getattr(request.state, "user", None)
    if not user:
        return

    auth_method = getattr(request.state, "auth_method", None)
    if auth_method == "legacy":
        return

    user_role = user.get("user_role", "free")
    if user_role == "admin":
        return

    tier_service = get_tier_service()
    if not tier_service:
        return

    user_id = user.get("id")
    if not user_id:
        return

    if isinstance(user_id, str):
        user_id = UUID(user_id)

    await tier_service.increment_usage(user_id)


def require_role(*allowed_roles: str):
    """
    FastAPI dependency factory that checks if user has the required role.

    Usage:
        @router.post("/projects/create")
        async def create_project(
            ...,
            role_check: dict = Depends(require_role("pro", "max", "admin"))
        ):

    Legacy (TPMS) users are always allowed (they have full access).
    """

    async def role_checker(request: Request) -> dict:
        user = getattr(request.state, "user", None)

        # Legacy users always pass
        auth_method = getattr(request.state, "auth_method", None)
        if auth_method == "legacy":
            return {"role_check": "bypassed", "reason": "legacy_user"}

        if not user:
            raise HTTPException(status_code=401, detail="Authentication required")

        user_role = user.get("user_role", "free")

        if user_role not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "insufficient_tier",
                    "message": f"This feature requires one of: {', '.join(allowed_roles)}. Your current tier: {user_role}.",
                    "current_tier": user_role,
                    "required_tiers": list(allowed_roles),
                    "upgrade_url": "/upgrade",
                },
            )

        return {"role_check": "passed", "user_role": user_role}

    return role_checker
