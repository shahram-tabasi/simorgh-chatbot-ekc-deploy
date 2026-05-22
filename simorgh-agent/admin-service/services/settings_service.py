"""
Runtime settings service — CRUD on `system_settings` with secret encryption.

Exposes:
  list_settings(category=None, scope=None, reveal_secrets=False)
  get_setting(key, scope='', reveal_secrets=False)
  upsert_setting(key, scope, value, ..., updated_by=None)
  delete_setting(key, scope='')
  for_scope(scope) -> {key: value}      ← used by live-settings client
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from uuid import UUID

import asyncpg
from services.postgres_auth_service import get_postgres_auth_service
from services.secret_box import encrypt, decrypt, mask


# Keys we never return in plaintext through the regular list endpoint, even
# when not flagged is_secret in the DB. Belt-and-braces.
_ALWAYS_MASK = {"JWT_SECRET_KEY", "MASTER_ENCRYPTION_KEY", "ADMIN_SETUP_SECRET"}


def _row_to_dict(row, *, reveal_secrets: bool) -> Dict[str, Any]:
    raw = row["value"]
    decrypted = decrypt(raw) if row["is_secret"] else raw
    if row["is_secret"] and not reveal_secrets:
        display = mask(decrypted) if decrypted is not None else None
    else:
        display = decrypted

    forced_mask = (not reveal_secrets) and (row["key"] in _ALWAYS_MASK)
    if forced_mask:
        display = mask(decrypted) if decrypted is not None else None

    return {
        "id":                str(row["id"]),
        "key":               row["key"],
        "scope":             row["scope"],
        "value":             display,
        "value_type":        row["value_type"],
        "category":          row["category"],
        "description":       row["description"],
        "is_secret":         row["is_secret"],
        "requires_restart":  row["requires_restart"],
        "is_readonly":       row["is_readonly"],
        "updated_by":        str(row["updated_by"]) if row.get("updated_by") else None,
        "created_at":        row["created_at"].isoformat() if row.get("created_at") else None,
        "updated_at":        row["updated_at"].isoformat() if row.get("updated_at") else None,
    }


async def list_settings(
    category: Optional[str] = None,
    scope: Optional[str] = None,
    reveal_secrets: bool = False,
) -> List[Dict[str, Any]]:
    db = get_postgres_auth_service().db
    where, params, idx = [], [], 1
    if category:
        where.append(f"category = ${idx}")
        params.append(category)
        idx += 1
    if scope is not None:
        where.append(f"scope = ${idx}")
        params.append(scope)
        idx += 1
    sql = "SELECT * FROM system_settings"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY category, scope, key"
    try:
        rows = await db.execute_async(sql, *params)
    except asyncpg.exceptions.UndefinedTableError:
        return []
    return [_row_to_dict(r, reveal_secrets=reveal_secrets) for r in rows]


async def get_setting(
    key: str, scope: str = "", reveal_secrets: bool = False,
) -> Optional[Dict[str, Any]]:
    db = get_postgres_auth_service().db
    row = await db.execute_one_async(
        "SELECT * FROM system_settings WHERE key = $1 AND scope = $2", key, scope,
    )
    return _row_to_dict(row, reveal_secrets=reveal_secrets) if row else None


async def for_scope(scope: str) -> Dict[str, str]:
    """Resolved (scope = '' OR scope = X) view, decrypted, for a service."""
    db = get_postgres_auth_service().db
    try:
        rows = await db.execute_async(
            "SELECT key, value, is_secret FROM system_settings "
            "WHERE scope = '' OR scope = $1 "
            "ORDER BY scope NULLS FIRST",  # global first, then service-specific overrides
            scope,
        )
    except asyncpg.exceptions.UndefinedTableError:
        # Migration 004 not yet applied — return empty so callers fall back to env vars.
        return {}
    out: Dict[str, str] = {}
    for r in rows:
        v = decrypt(r["value"]) if r["is_secret"] else r["value"]
        if v is not None:
            out[r["key"]] = v
    return out


async def upsert_setting(
    key: str,
    scope: str,
    value: Optional[str],
    *,
    value_type: Optional[str] = None,
    category: Optional[str] = None,
    description: Optional[str] = None,
    is_secret: Optional[bool] = None,
    requires_restart: Optional[bool] = None,
    is_readonly: Optional[bool] = None,
    updated_by: Optional[UUID] = None,
) -> Dict[str, Any]:
    """Insert or update a row. Returns the new row dict (secrets masked)."""
    db = get_postgres_auth_service().db
    existing = await db.execute_one_async(
        "SELECT * FROM system_settings WHERE key = $1 AND scope = $2", key, scope,
    )

    # Never let the API mutate a row marked is_readonly except by an explicit
    # service-side path. The route already blocks this; this is defence-in-depth.
    if existing and existing["is_readonly"] and is_readonly is None:
        raise ValueError(f"setting {key!r} (scope={scope!r}) is read-only")

    secret = is_secret if is_secret is not None else (existing["is_secret"] if existing else False)
    stored_value = encrypt(value) if secret else value

    if existing:
        row = await db.execute_one_async(
            """
            UPDATE system_settings SET
                value            = $1,
                value_type       = COALESCE($2, value_type),
                category         = COALESCE($3, category),
                description      = COALESCE($4, description),
                is_secret        = COALESCE($5, is_secret),
                requires_restart = COALESCE($6, requires_restart),
                is_readonly      = COALESCE($7, is_readonly),
                updated_by       = $8,
                updated_at       = NOW()
            WHERE key = $9 AND scope = $10
            RETURNING *
            """,
            stored_value, value_type, category, description, is_secret,
            requires_restart, is_readonly, updated_by, key, scope,
        )
    else:
        row = await db.execute_one_async(
            """
            INSERT INTO system_settings
              (key, scope, value, value_type, category, description,
               is_secret, requires_restart, is_readonly, updated_by)
            VALUES ($1, $2, $3, COALESCE($4, 'string'), COALESCE($5, 'general'),
                    $6, COALESCE($7, FALSE), COALESCE($8, FALSE),
                    COALESCE($9, FALSE), $10)
            RETURNING *
            """,
            key, scope, stored_value, value_type, category, description,
            is_secret, requires_restart, is_readonly, updated_by,
        )
    return _row_to_dict(row, reveal_secrets=False)


async def delete_setting(key: str, scope: str = "") -> bool:
    db = get_postgres_auth_service().db
    res = await db.execute_async(
        "DELETE FROM system_settings WHERE key = $1 AND scope = $2 RETURNING id",
        key, scope,
    )
    return bool(res)


async def categories() -> List[Dict[str, Any]]:
    """Distinct (category, count) pairs for the UI sidebar."""
    db = get_postgres_auth_service().db
    try:
        rows = await db.execute_async(
            "SELECT category, COUNT(*) AS n FROM system_settings GROUP BY category ORDER BY category"
        )
    except asyncpg.exceptions.UndefinedTableError:
        return []
    return [{"category": r["category"], "count": r["n"]} for r in rows]
