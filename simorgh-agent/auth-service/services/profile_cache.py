"""
User profile cache + role normalization.
=========================================
After a successful legacy login, auth-service writes a small profile
record to Redis at `user_profile:{user_id}` with a 24h TTL. Other
services read from there (or from JWT claims) to know the user's role
without re-running the legacy MySQL query on every request.

The canonical role buckets used elsewhere in the stack
(see GENERAL_CHAT_DESIGN.md) are:

    expert_technical          expert_offer            expert_sales
    expert_warehouse          expert_customer_service expert_project_planning
    expert_production         expert_quality_control  expert_office
    manager_technical         manager_offer           manager_production
    manager_quality_control   manager_hr              other

`normalize_role_category()` is a best-effort mapping from whatever string
the TPMS table happens to put in EMPROLE to one of those buckets. Edit
the rules table below as you discover the real values.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

REDIS_URL          = os.getenv("REDIS_URL", "redis://redis:6379/0")
USER_PROFILE_TTL   = int(os.getenv("USER_PROFILE_TTL_SEC", "86400"))  # 24h


# ---------------------------------------------------------------------------
# Role normalization
# ---------------------------------------------------------------------------
# Each rule maps a list of substrings (case-insensitive) → bucket. First
# match wins. Unmatched roles fall through to "other".
_ROLE_RULES: list[tuple[list[str], str]] = [
    # Managers first (more specific)
    (["manager", "technical"],          "manager_technical"),
    (["manager", "offer"],               "manager_offer"),
    (["manager", "production"],          "manager_production"),
    (["manager", "qc"],                  "manager_quality_control"),
    (["manager", "quality"],             "manager_quality_control"),
    (["manager", "hr"],                  "manager_hr"),
    (["manager"],                        "other"),  # generic manager → other for now
    # Experts
    (["technical"],                      "expert_technical"),
    (["offer"],                          "expert_offer"),
    (["sales"],                          "expert_sales"),
    (["warehouse"],                      "expert_warehouse"),
    (["customer", "service"],            "expert_customer_service"),
    (["project", "planning"],            "expert_project_planning"),
    (["planning"],                       "expert_project_planning"),
    (["production", "quality"],          "expert_quality_control"),
    (["qc"],                             "expert_quality_control"),
    (["quality"],                        "expert_quality_control"),
    (["production"],                     "expert_production"),
    (["office"],                         "expert_office"),
    (["hr"],                             "manager_hr"),  # any HR person → HR bucket
]


def normalize_role_category(raw: Optional[str]) -> str:
    """Map a free-text role string to one of the canonical buckets."""
    if not raw:
        return "other"
    s = re.sub(r"[^a-z]+", " ", raw.lower()).strip()
    if not s:
        return "other"
    for substrings, bucket in _ROLE_RULES:
        if all(sub in s for sub in substrings):
            return bucket
    return "other"


# ---------------------------------------------------------------------------
# Redis helpers
# ---------------------------------------------------------------------------
_redis_client = None


def _redis():
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    try:
        import redis
        _redis_client = redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=2)
        _redis_client.ping()
        return _redis_client
    except Exception as e:
        logger.warning("Redis unavailable, profile cache disabled: %s", e)
        _redis_client = None
        return None


def build_profile(tpms_user: Dict[str, Any]) -> Dict[str, Any]:
    """Build the JSON-able profile we cache in Redis."""
    raw_role = (
        tpms_user.get("EMPROLE")
        or tpms_user.get("emprole")
        or tpms_user.get("role")
    )
    full_name = " ".join(filter(None, [
        tpms_user.get("EMPFIRSTNAME") or tpms_user.get("EmpFirstName") or tpms_user.get("first_name"),
        tpms_user.get("EMPLASTNAME")  or tpms_user.get("EmpLastName")  or tpms_user.get("last_name"),
    ])).strip()
    department = (
        tpms_user.get("DEPARTMENT")
        or tpms_user.get("Department")
        or tpms_user.get("department")
    )
    return {
        "user_id":       str(tpms_user.get("ID") or tpms_user.get("EMPUSERNAME") or ""),
        "username":      tpms_user.get("EMPUSERNAME"),
        "full_name":     full_name or tpms_user.get("EMPUSERNAME"),
        "email":         tpms_user.get("EMAIL") or tpms_user.get("Email") or tpms_user.get("email"),
        "department":    department,
        "role":          raw_role,
        "role_category": normalize_role_category(raw_role),
        "loaded_at":     datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }


def write_profile_to_redis(profile: Dict[str, Any]) -> bool:
    """Persist profile under user_profile:{user_id} for USER_PROFILE_TTL seconds."""
    r = _redis()
    if r is None or not profile.get("user_id"):
        return False
    try:
        r.setex(
            f"user_profile:{profile['user_id']}",
            USER_PROFILE_TTL,
            json.dumps(profile, ensure_ascii=False),
        )
        return True
    except Exception:
        logger.exception("failed to write user_profile to redis")
        return False
