"""
Tier & Quota Models (Pydantic)

Data models for user tiers, quotas, usage tracking, and payments.
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field
from uuid import UUID


# =============================================================================
# Tier Quota Info
# =============================================================================

class TierQuotaInfo(BaseModel):
    """Tier quota configuration."""
    tier_name: str
    max_questions_per_day: int
    can_create_projects: bool = False
    can_use_offline_llm: bool = False
    can_use_tools: bool = False
    subscription_duration_days: Optional[int] = None
    description: Optional[str] = None


# =============================================================================
# User Quota Status
# =============================================================================

class QuotaStatusResponse(BaseModel):
    """Current user quota status."""
    user_role: str = "free"
    questions_used_today: int = 0
    questions_limit: int = 20
    questions_remaining: int = 20
    can_create_projects: bool = False
    can_use_offline_llm: bool = False
    can_use_tools: bool = False
    subscription_expires_at: Optional[datetime] = None
    subscription_active: bool = True
    resets_at: str = ""  # ISO datetime string when daily quota resets


class QuotaExceededResponse(BaseModel):
    """Response when quota is exceeded."""
    error: str = "quota_exceeded"
    message: str
    questions_used: int
    questions_limit: int
    resets_at: str
    upgrade_url: str = "/upgrade"


# =============================================================================
# Admin Tier Management
# =============================================================================

class UpdateUserRoleRequest(BaseModel):
    """Admin request to change a user's role."""
    user_role: str = Field(..., pattern='^(free|pro|max|admin)$')
    subscription_days: Optional[int] = Field(None, ge=1, le=365)


class AdminSetupRequest(BaseModel):
    """Request to create/promote admin user."""
    email: str
    password: Optional[str] = None  # no longer required; admin_secret is the gate
    admin_secret: str


class TierQuotaUpdateRequest(BaseModel):
    """Admin request to update tier quotas."""
    max_questions_per_day: Optional[int] = Field(None, ge=1)
    can_create_projects: Optional[bool] = None
    can_use_tools: Optional[bool] = None
    subscription_duration_days: Optional[int] = Field(None, ge=1)
    description: Optional[str] = None
