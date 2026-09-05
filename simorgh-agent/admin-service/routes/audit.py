"""
Audit log read endpoint.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from routes._auth import require_admin
from services import audit_service

router = APIRouter(prefix="/api/v2/admin", tags=["Audit"])


@router.get("/audit")
async def list_audit(
    actor_id: Optional[UUID] = Query(None),
    action: Optional[str] = Query(None),
    target_type: Optional[str] = Query(None),
    target_id: Optional[str] = Query(None),
    since: Optional[str] = Query(None, description="ISO-8601 timestamp"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _: dict = Depends(require_admin),
) -> Dict[str, Any]:
    rows = await audit_service.list_entries(
        actor_id=actor_id, action=action, target_type=target_type,
        target_id=target_id, since=since, limit=limit, offset=offset,
    )
    return {"entries": rows, "limit": limit, "offset": offset}
