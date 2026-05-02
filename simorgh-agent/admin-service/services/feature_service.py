"""
Feature flag CRUD + per-user override resolution.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from uuid import UUID

from services.postgres_auth_service import get_postgres_auth_service


_ROLE_RANK = {"free": 0, "pro": 1, "max": 2, "admin": 3}


def _flag_to_dict(row) -> Dict[str, Any]:
    return {
        "id":          str(row["id"]),
        "name":        row["name"],
        "description": row["description"],
        "enabled":     row["enabled"],
        "min_role":    row["min_role"],
        "category":    row["category"],
        "updated_by":  str(row["updated_by"]) if row.get("updated_by") else None,
        "updated_at":  row["updated_at"].isoformat() if row.get("updated_at") else None,
    }


async def list_flags(category: Optional[str] = None) -> List[Dict[str, Any]]:
    db = get_postgres_auth_service().db
    if category:
        rows = await db.execute_async(
            "SELECT * FROM feature_flags WHERE category = $1 ORDER BY name", category,
        )
    else:
        rows = await db.execute_async("SELECT * FROM feature_flags ORDER BY category, name")
    return [_flag_to_dict(r) for r in rows]


async def get_flag(name: str) -> Optional[Dict[str, Any]]:
    db = get_postgres_auth_service().db
    row = await db.execute_one_async(
        "SELECT * FROM feature_flags WHERE name = $1", name,
    )
    return _flag_to_dict(row) if row else None


async def upsert_flag(
    name: str,
    *,
    enabled: Optional[bool] = None,
    min_role: Optional[str] = None,
    description: Optional[str] = None,
    category: Optional[str] = None,
    updated_by: Optional[UUID] = None,
) -> Dict[str, Any]:
    if min_role is not None and min_role not in _ROLE_RANK:
        raise ValueError(f"invalid min_role {min_role!r}")
    db = get_postgres_auth_service().db
    existing = await db.execute_one_async(
        "SELECT * FROM feature_flags WHERE name = $1", name,
    )
    if existing:
        row = await db.execute_one_async(
            """
            UPDATE feature_flags SET
                enabled     = COALESCE($1, enabled),
                min_role    = COALESCE($2, min_role),
                description = COALESCE($3, description),
                category    = COALESCE($4, category),
                updated_by  = $5,
                updated_at  = NOW()
            WHERE name = $6
            RETURNING *
            """,
            enabled, min_role, description, category, updated_by, name,
        )
    else:
        row = await db.execute_one_async(
            """
            INSERT INTO feature_flags (name, enabled, min_role, description, category, updated_by)
            VALUES ($1, COALESCE($2, TRUE), COALESCE($3, 'free'), $4,
                    COALESCE($5, 'general'), $6)
            RETURNING *
            """,
            name, enabled, min_role, description, category, updated_by,
        )
    return _flag_to_dict(row)


async def delete_flag(name: str) -> bool:
    db = get_postgres_auth_service().db
    res = await db.execute_async(
        "DELETE FROM feature_flags WHERE name = $1 RETURNING id", name,
    )
    return bool(res)


# -----------------------------------------------------------------------------
# Per-user overrides
# -----------------------------------------------------------------------------
async def list_user_overrides(user_id: UUID) -> List[Dict[str, Any]]:
    db = get_postgres_auth_service().db
    rows = await db.execute_async(
        "SELECT * FROM user_feature_overrides WHERE user_id = $1 ORDER BY feature_name",
        user_id,
    )
    return [
        {
            "id":           str(r["id"]),
            "user_id":      str(r["user_id"]),
            "feature_name": r["feature_name"],
            "enabled":      r["enabled"],
            "note":         r["note"],
            "created_at":   r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in rows
    ]


async def upsert_user_override(
    user_id: UUID,
    feature_name: str,
    enabled: bool,
    *,
    note: Optional[str] = None,
    created_by: Optional[UUID] = None,
) -> Dict[str, Any]:
    db = get_postgres_auth_service().db
    row = await db.execute_one_async(
        """
        INSERT INTO user_feature_overrides (user_id, feature_name, enabled, note, created_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, feature_name) DO UPDATE SET
            enabled    = EXCLUDED.enabled,
            note       = EXCLUDED.note,
            created_by = EXCLUDED.created_by
        RETURNING *
        """,
        user_id, feature_name, enabled, note, created_by,
    )
    return {
        "id":           str(row["id"]),
        "user_id":      str(row["user_id"]),
        "feature_name": row["feature_name"],
        "enabled":      row["enabled"],
        "note":         row["note"],
    }


async def delete_user_override(user_id: UUID, feature_name: str) -> bool:
    db = get_postgres_auth_service().db
    res = await db.execute_async(
        "DELETE FROM user_feature_overrides WHERE user_id = $1 AND feature_name = $2 RETURNING id",
        user_id, feature_name,
    )
    return bool(res)


async def resolve_for_user(user_id: UUID, user_role: str) -> Dict[str, bool]:
    """
    Effective enable/disable per feature for one user. Resolution order:
        per-user override → global flag.enabled AND user_role >= flag.min_role.
    """
    db = get_postgres_auth_service().db
    flags = await db.execute_async("SELECT * FROM feature_flags")
    overrides = await db.execute_async(
        "SELECT feature_name, enabled FROM user_feature_overrides WHERE user_id = $1",
        user_id,
    )
    override_map = {o["feature_name"]: o["enabled"] for o in overrides}
    user_rank = _ROLE_RANK.get((user_role or "free").lower(), 0)
    out: Dict[str, bool] = {}
    for f in flags:
        if f["name"] in override_map:
            out[f["name"]] = override_map[f["name"]]
            continue
        global_ok = bool(f["enabled"])
        role_ok = user_rank >= _ROLE_RANK.get(f["min_role"], 0)
        out[f["name"]] = global_ok and role_ok
    return out
