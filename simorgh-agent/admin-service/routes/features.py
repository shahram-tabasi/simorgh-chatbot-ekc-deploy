"""
Feature-flag routes — global flags + per-user overrides.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from routes._auth import require_admin
from services import audit_service, feature_service

router = APIRouter(prefix="/api/v2/admin", tags=["Features"])


class FlagUpsert(BaseModel):
    name: str
    enabled: Optional[bool] = None
    min_role: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None


class FlagPatch(BaseModel):
    enabled: Optional[bool] = None
    min_role: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None


class UserOverrideRequest(BaseModel):
    feature_name: str
    enabled: bool
    note: Optional[str] = None


@router.get("/features")
async def list_flags(
    category: Optional[str] = Query(None),
    _: dict = Depends(require_admin),
) -> List[Dict[str, Any]]:
    return await feature_service.list_flags(category=category)


@router.get("/features/{name}")
async def get_flag(name: str, _: dict = Depends(require_admin)) -> Dict[str, Any]:
    flag = await feature_service.get_flag(name)
    if not flag:
        raise HTTPException(status_code=404, detail="Feature flag not found")
    return flag


@router.post("/features")
async def create_or_upsert_flag(
    body: FlagUpsert, request: Request, admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    before = await feature_service.get_flag(body.name)
    try:
        flag = await feature_service.upsert_flag(
            body.name,
            enabled=body.enabled,
            min_role=body.min_role,
            description=body.description,
            category=body.category,
            updated_by=admin["id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await audit_service.record(
        admin, "feature.upsert",
        target_type="feature_flag", target_id=body.name,
        before=before, after=flag, request=request,
    )
    return flag


@router.patch("/features/{name}")
async def patch_flag(
    name: str, body: FlagPatch, request: Request,
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    before = await feature_service.get_flag(name)
    if not before:
        raise HTTPException(status_code=404, detail="Feature flag not found")
    try:
        flag = await feature_service.upsert_flag(
            name,
            enabled=body.enabled,
            min_role=body.min_role,
            description=body.description,
            category=body.category,
            updated_by=admin["id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await audit_service.record(
        admin, "feature.update",
        target_type="feature_flag", target_id=name,
        before=before, after=flag, request=request,
    )
    return flag


@router.delete("/features/{name}")
async def delete_flag(
    name: str, request: Request, admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    before = await feature_service.get_flag(name)
    if not before:
        raise HTTPException(status_code=404, detail="Feature flag not found")
    ok = await feature_service.delete_flag(name)
    await audit_service.record(
        admin, "feature.delete",
        target_type="feature_flag", target_id=name,
        before=before, after=None, request=request,
    )
    return {"deleted": ok}


# -----------------------------------------------------------------------------
# Per-user overrides
# -----------------------------------------------------------------------------
@router.get("/users/{user_id}/features")
async def list_user_overrides(
    user_id: UUID, _: dict = Depends(require_admin),
) -> Dict[str, Any]:
    overrides = await feature_service.list_user_overrides(user_id)
    return {"user_id": str(user_id), "overrides": overrides}


@router.post("/users/{user_id}/features")
async def upsert_user_override(
    user_id: UUID, body: UserOverrideRequest, request: Request,
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    out = await feature_service.upsert_user_override(
        user_id, body.feature_name, body.enabled, note=body.note, created_by=admin["id"],
    )
    await audit_service.record(
        admin, "feature.user_override",
        target_type="user_feature_override",
        target_id=f"{user_id}:{body.feature_name}",
        after=out, request=request,
    )
    return out


@router.delete("/users/{user_id}/features/{feature_name}")
async def delete_user_override(
    user_id: UUID, feature_name: str, request: Request,
    admin: dict = Depends(require_admin),
) -> Dict[str, Any]:
    ok = await feature_service.delete_user_override(user_id, feature_name)
    await audit_service.record(
        admin, "feature.user_override_delete",
        target_type="user_feature_override",
        target_id=f"{user_id}:{feature_name}",
        request=request,
    )
    return {"deleted": ok}


@router.get("/users/{user_id}/features/resolved")
async def resolved_for_user(
    user_id: UUID, _: dict = Depends(require_admin),
) -> Dict[str, Any]:
    """Effective enable/disable per feature for one user — UI uses this."""
    from services.postgres_auth_service import get_postgres_auth_service
    user = await get_postgres_auth_service().get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    resolved = await feature_service.resolve_for_user(user_id, user.get("user_role", "free"))
    return {"user_id": str(user_id), "user_role": user.get("user_role"), "features": resolved}
