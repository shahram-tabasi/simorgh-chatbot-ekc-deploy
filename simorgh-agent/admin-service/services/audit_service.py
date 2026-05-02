"""
Audit log writer + reader. Every PATCH/POST/DELETE through admin routes
should call `record(...)` so we have a "who did what, when" trail.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import Request

from services.postgres_auth_service import get_postgres_auth_service

logger = logging.getLogger("audit")


def _safe_json(payload: Any) -> Optional[str]:
    if payload is None:
        return None
    try:
        return json.dumps(payload, default=str)
    except Exception:
        return json.dumps({"_unserialisable": str(payload)[:500]})


async def record(
    actor: Optional[Dict[str, Any]],
    action: str,
    *,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    before: Optional[Dict[str, Any]] = None,
    after: Optional[Dict[str, Any]] = None,
    metadata: Optional[Dict[str, Any]] = None,
    request: Optional[Request] = None,
) -> None:
    """Best-effort audit write. Never raises into the caller."""
    try:
        db = get_postgres_auth_service().db
        ip = None
        ua = None
        if request is not None:
            client = request.client
            ip = (client.host if client else None) or request.headers.get("x-forwarded-for")
            ua = request.headers.get("user-agent")
        await db.execute_async(
            """
            INSERT INTO admin_audit_log
              (actor_id, actor_email, action, target_type, target_id,
               before_state, after_state, metadata, ip_address, user_agent)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
            """,
            (actor or {}).get("id"),
            (actor or {}).get("email"),
            action,
            target_type,
            target_id,
            _safe_json(before),
            _safe_json(after),
            _safe_json(metadata),
            ip,
            ua,
        )
    except Exception as exc:
        # Audit must not break the operation it's logging.
        logger.error("audit write failed (action=%s): %s", action, exc)


async def list_entries(
    *,
    actor_id: Optional[UUID] = None,
    action: Optional[str] = None,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    since: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    db = get_postgres_auth_service().db
    where, params, idx = [], [], 1
    if actor_id:
        where.append(f"actor_id = ${idx}")
        params.append(actor_id)
        idx += 1
    if action:
        where.append(f"action = ${idx}")
        params.append(action)
        idx += 1
    if target_type:
        where.append(f"target_type = ${idx}")
        params.append(target_type)
        idx += 1
    if target_id:
        where.append(f"target_id = ${idx}")
        params.append(target_id)
        idx += 1
    if since:
        where.append(f"created_at >= ${idx}")
        params.append(since)
        idx += 1
    sql = "SELECT * FROM admin_audit_log"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    params.extend([limit, offset])
    rows = await db.execute_async(sql, *params)
    out: List[Dict[str, Any]] = []
    for r in rows:
        out.append({
            "id":            str(r["id"]),
            "actor_id":      str(r["actor_id"]) if r.get("actor_id") else None,
            "actor_email":   r.get("actor_email"),
            "action":        r["action"],
            "target_type":   r.get("target_type"),
            "target_id":     r.get("target_id"),
            "before_state":  r.get("before_state"),
            "after_state":   r.get("after_state"),
            "metadata":      r.get("metadata"),
            "ip_address":    str(r["ip_address"]) if r.get("ip_address") else None,
            "user_agent":    r.get("user_agent"),
            "created_at":    r["created_at"].isoformat() if r.get("created_at") else None,
        })
    return out
