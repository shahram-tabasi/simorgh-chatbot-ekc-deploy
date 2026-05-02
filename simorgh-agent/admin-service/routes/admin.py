"""
Admin Routes (Phase 4)

Endpoints for:
- Admin setup (first admin via ADMIN_SETUP_SECRET)
- User listing, search, role changes
- Tier quota management
- System stats
"""

import logging
from uuid import UUID
from typing import Optional
from datetime import datetime

from fastapi import APIRouter, HTTPException, Depends, Query

from routes._auth import get_current_user, require_admin
from services.user_tier_service import get_tier_service
from services.postgres_auth_service import get_postgres_auth_service
from models.tier_models import (
    AdminSetupRequest,
    UpdateUserRoleRequest,
    TierQuotaUpdateRequest,
    TierQuotaInfo,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/admin", tags=["Admin"])


# =============================================================================
# Admin Setup (no auth required - uses secret)
# =============================================================================

@router.post("/setup")
async def setup_admin(request: AdminSetupRequest):
    """
    Set up the first admin user.

    Requires ADMIN_SETUP_SECRET env var to match.
    The user must already exist (registered via email).
    """
    auth_service = get_postgres_auth_service()
    tier_service = get_tier_service()

    if not tier_service:
        raise HTTPException(status_code=503, detail="Tier service not initialized")

    # Authenticate the user first
    user = await auth_service.authenticate_user(request.email, request.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Promote to admin via secret
    success, message = await tier_service.setup_admin(user["id"], request.admin_secret)

    if not success:
        raise HTTPException(status_code=403, detail=message)

    return {"message": message, "user_role": "admin"}


# =============================================================================
# User Management
# =============================================================================

@router.get("/users")
async def list_users(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: Optional[str] = Query(None),
    role: Optional[str] = Query(None, pattern="^(free|pro|max|admin)$"),
    admin: dict = Depends(require_admin),
):
    """List all modern users with pagination and optional filters."""
    auth_service = get_postgres_auth_service()
    db = auth_service.db

    offset = (page - 1) * per_page

    # Build query with optional filters
    conditions = []
    params = []
    param_idx = 1

    if search:
        conditions.append(
            f"(email ILIKE ${param_idx} OR first_name ILIKE ${param_idx} "
            f"OR last_name ILIKE ${param_idx} OR display_name ILIKE ${param_idx})"
        )
        params.append(f"%{search}%")
        param_idx += 1

    if role:
        conditions.append(f"user_role = ${param_idx}")
        params.append(role)
        param_idx += 1

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    # Count total
    count_query = f"SELECT COUNT(*) as total FROM users {where_clause}"
    count_result = await db.execute_one_async(count_query, *params)
    total = count_result["total"] if count_result else 0

    # Fetch users
    query = f"""
        SELECT id, email, first_name, last_name, display_name, avatar_url,
               email_verified, is_active, user_role, subscription_expires_at,
               created_at, last_login_at
        FROM users
        {where_clause}
        ORDER BY created_at DESC
        LIMIT ${param_idx} OFFSET ${param_idx + 1}
    """
    params.extend([per_page, offset])

    users = await db.execute_async(query, *params)

    return {
        "users": [dict(u) for u in users],
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": (total + per_page - 1) // per_page,
    }


@router.get("/users/{user_id}")
async def get_user_detail(
    user_id: UUID,
    admin: dict = Depends(require_admin),
):
    """Get detailed user information including usage stats."""
    auth_service = get_postgres_auth_service()
    tier_service = get_tier_service()

    user = await auth_service.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Get quota status
    quota_info = {}
    if tier_service:
        quota_info = await tier_service.get_quota_status(
            user_id, user.get("user_role", "free"),
            user.get("subscription_expires_at")
        )

    return {
        **user,
        "quota": quota_info,
    }


@router.patch("/users/{user_id}/role")
async def update_user_role(
    user_id: UUID,
    request: UpdateUserRoleRequest,
    admin: dict = Depends(require_admin),
):
    """Change a user's tier/role."""
    tier_service = get_tier_service()
    if not tier_service:
        raise HTTPException(status_code=503, detail="Tier service not initialized")

    auth_service = get_postgres_auth_service()
    user = await auth_service.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Prevent self-demotion
    if str(user_id) == str(admin["id"]) and request.user_role != "admin":
        raise HTTPException(status_code=400, detail="Cannot demote yourself")

    await tier_service.upgrade_user(user_id, request.user_role, request.subscription_days)

    logger.info(
        f"Admin {admin['email']} changed user {user['email']} "
        f"role to {request.user_role}"
    )

    return {
        "message": f"User role updated to {request.user_role}",
        "user_id": str(user_id),
        "new_role": request.user_role,
    }


@router.patch("/users/{user_id}/active")
async def toggle_user_active(
    user_id: UUID,
    admin: dict = Depends(require_admin),
):
    """Toggle a user's active status (enable/disable account)."""
    auth_service = get_postgres_auth_service()
    db = auth_service.db

    user = await auth_service.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Prevent self-deactivation
    if str(user_id) == str(admin["id"]):
        raise HTTPException(status_code=400, detail="Cannot deactivate yourself")

    new_status = not user.get("is_active", True)
    await db.execute_async(
        "UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2",
        new_status, user_id
    )

    action = "activated" if new_status else "deactivated"
    logger.info(f"Admin {admin['email']} {action} user {user['email']}")

    return {"message": f"User {action}", "is_active": new_status}


# =============================================================================
# Tier Quota Management
# =============================================================================

@router.get("/tiers")
async def get_tier_configs(admin: dict = Depends(require_admin)):
    """Get all tier quota configurations (admin view)."""
    tier_service = get_tier_service()
    if not tier_service:
        raise HTTPException(status_code=503, detail="Tier service not initialized")

    tiers = await tier_service.get_all_tier_quotas()
    return tiers


@router.patch("/tiers/{tier_name}")
async def update_tier_config(
    tier_name: str,
    request: TierQuotaUpdateRequest,
    admin: dict = Depends(require_admin),
):
    """Update a tier's quota configuration."""
    if tier_name not in ("free", "pro", "max", "admin"):
        raise HTTPException(status_code=400, detail="Invalid tier name")

    tier_service = get_tier_service()
    if not tier_service:
        raise HTTPException(status_code=503, detail="Tier service not initialized")

    updates = request.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")

    await tier_service.update_tier_quotas(tier_name, **updates)

    logger.info(f"Admin {admin['email']} updated tier {tier_name}: {updates}")

    return {"message": f"Tier {tier_name} updated", "updates": updates}


# =============================================================================
# System Stats
# =============================================================================

@router.get("/stats")
async def get_system_stats(admin: dict = Depends(require_admin)):
    """Get system-wide statistics."""
    auth_service = get_postgres_auth_service()
    db = auth_service.db

    # User counts by role
    role_counts = await db.execute_async(
        "SELECT user_role, COUNT(*) as count FROM users GROUP BY user_role ORDER BY user_role"
    )

    # Total users
    total_result = await db.execute_one_async("SELECT COUNT(*) as total FROM users")
    total_users = total_result["total"] if total_result else 0

    # Active today (users who have daily usage today)
    active_today_result = await db.execute_one_async(
        "SELECT COUNT(DISTINCT user_id) as count FROM user_daily_usage "
        "WHERE usage_date = CURRENT_DATE AND questions_used > 0"
    )
    active_today = active_today_result["count"] if active_today_result else 0

    # Total questions today
    questions_today_result = await db.execute_one_async(
        "SELECT COALESCE(SUM(questions_used), 0) as total FROM user_daily_usage "
        "WHERE usage_date = CURRENT_DATE"
    )
    questions_today = questions_today_result["total"] if questions_today_result else 0

    # New users last 7 days
    new_users_result = await db.execute_one_async(
        "SELECT COUNT(*) as count FROM users "
        "WHERE created_at >= NOW() - INTERVAL '7 days'"
    )
    new_users_7d = new_users_result["count"] if new_users_result else 0

    # Expiring subscriptions (next 7 days)
    expiring_result = await db.execute_one_async(
        "SELECT COUNT(*) as count FROM users "
        "WHERE subscription_expires_at IS NOT NULL "
        "AND subscription_expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'"
    )
    expiring_soon = expiring_result["count"] if expiring_result else 0

    return {
        "total_users": total_users,
        "users_by_role": {r["user_role"]: r["count"] for r in role_counts},
        "active_today": active_today,
        "questions_today": questions_today,
        "new_users_7d": new_users_7d,
        "expiring_subscriptions_7d": expiring_soon,
    }
