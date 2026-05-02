"""
Generic settings CRUD — `system_settings` table.

GET    /api/v2/admin/settings              list all (with category/scope filters)
GET    /api/v2/admin/settings/categories   sidebar counts
GET    /api/v2/admin/settings/{key}        single value
POST   /api/v2/admin/settings              create or upsert
PATCH  /api/v2/admin/settings/{key}        update value (and optionally metadata)
DELETE /api/v2/admin/settings/{key}        delete

Plus an internal-only endpoint that other services use to fetch the
resolved snapshot for a given scope:

GET    /api/v2/admin/internal/settings/scope/{scope}

Internal calls authenticate via `X-Internal-Token: <SETTINGS_INTERNAL_TOKEN>`,
not via JWT — services don't have user identities.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel

from routes._auth import require_admin
from services import audit_service, settings_service

router = APIRouter(prefix="/api/v2/admin", tags=["Settings"])

_INTERNAL_TOKEN = os.getenv("SETTINGS_INTERNAL_TOKEN", "").strip()


class SettingUpsert(BaseModel):
    key: str
    scope: str = ""
    value: Optional[str] = None
    value_type: Optional[str] = None       # string|int|float|bool|json
    category: Optional[str] = None
    description: Optional[str] = None
    is_secret: Optional[bool] = None
    requires_restart: Optional[bool] = None
    is_readonly: Optional[bool] = None


class SettingPatch(BaseModel):
    value: Optional[str] = None
    description: Optional[str] = None
    is_secret: Optional[bool] = None
    requires_restart: Optional[bool] = None


@router.get("/settings/categories")
async def get_categories(_: dict = Depends(require_admin)) -> List[Dict[str, Any]]:
    return await settings_service.categories()


@router.get("/settings")
async def list_all(
    category: Optional[str] = Query(None),
    scope: Optional[str] = Query(None),
    reveal: int = Query(0, description="1 to return secret values in plaintext"),
    _: dict = Depends(require_admin),
) -> List[Dict[str, Any]]:
    return await settings_service.list_settings(
        category=category, scope=scope, reveal_secrets=bool(reveal),
    )


@router.get("/settings/{key}")
async def get_one(
    key: str,
    scope: str = Query(""),
    reveal: int = Query(0),
    _: dict = Depends(require_admin),
) -> Dict[str, Any]:
    row = await settings_service.get_setting(key, scope=scope, reveal_secrets=bool(reveal))
    if not row:
        raise HTTPException(status_code=404, detail="Setting not found")
    return row


@router.post("/settings")
async def create_or_upsert(
    body: SettingUpsert,
    request: Request,
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    before = await settings_service.get_setting(body.key, scope=body.scope, reveal_secrets=False)
    try:
        row = await settings_service.upsert_setting(
            body.key,
            body.scope,
            body.value,
            value_type=body.value_type,
            category=body.category,
            description=body.description,
            is_secret=body.is_secret,
            requires_restart=body.requires_restart,
            is_readonly=body.is_readonly,
            updated_by=admin["id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await audit_service.record(
        admin, "setting.upsert",
        target_type="setting",
        target_id=f"{body.scope}:{body.key}",
        before=before, after=row, request=request,
    )
    return row


@router.patch("/settings/{key}")
async def patch_one(
    key: str,
    body: SettingPatch,
    request: Request,
    scope: str = Query(""),
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    before = await settings_service.get_setting(key, scope=scope, reveal_secrets=False)
    if not before:
        raise HTTPException(status_code=404, detail="Setting not found")
    try:
        row = await settings_service.upsert_setting(
            key, scope, body.value if body.value is not None else before["value"],
            description=body.description,
            is_secret=body.is_secret,
            requires_restart=body.requires_restart,
            updated_by=admin["id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await audit_service.record(
        admin, "setting.update",
        target_type="setting",
        target_id=f"{scope}:{key}",
        before=before, after=row, request=request,
    )
    return row


@router.delete("/settings/{key}")
async def delete_one(
    key: str,
    request: Request,
    scope: str = Query(""),
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    before = await settings_service.get_setting(key, scope=scope, reveal_secrets=False)
    if not before:
        raise HTTPException(status_code=404, detail="Setting not found")
    if before.get("is_readonly"):
        raise HTTPException(status_code=400, detail="Setting is read-only")
    ok = await settings_service.delete_setting(key, scope=scope)
    await audit_service.record(
        admin, "setting.delete",
        target_type="setting",
        target_id=f"{scope}:{key}",
        before=before, after=None, request=request,
    )
    return {"deleted": ok}


# -----------------------------------------------------------------------------
# Internal: services pull their resolved settings snapshot
# -----------------------------------------------------------------------------
def _check_internal_token(token: Optional[str]) -> None:
    if not _INTERNAL_TOKEN:
        # Development convenience — if no token is configured, allow (and log
        # via the caller's nginx allowlist instead). In production set the env.
        return
    if token != _INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid internal token")


@router.get("/internal/settings/scope/{scope}")
async def internal_for_scope(
    scope: str,
    x_internal_token: Optional[str] = Header(None),
) -> Dict[str, str]:
    """Return resolved (global + service-scoped) settings as a flat dict."""
    _check_internal_token(x_internal_token)
    return await settings_service.for_scope(scope)
